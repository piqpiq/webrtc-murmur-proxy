"use strict"

import WebSocket from "ws"
import tls from "tls"
import net from "net"
import https from "https"
import fs from "fs"
import { nonstandard } from "wrtc"
import opus from "@discordjs/opus"
import EstablishPeerConnection from "./webrtcconnection"
import PacketDataStream from "./PacketDataStream"
const RTCAudioSink = nonstandard.RTCAudioSink

const murmurHost = "default.mumble.prod.hearo.live"
const murmurPort = 64738
const webRtcPort = 8136

var logging = false

const args = process.argv.slice(2)
if (args[0] === "log") {
  console.log("Logging enabled")
  logging = true
} else if (args.length) {
  console.log("Unknown argument(s):", ...args)
  process.exit()
}

console.log("Starting webrtc-mummur-proxy")

process.on('uncaughtException', function (exception) {
  console.log(exception);
});

process.on('unhandledRejection', (reason, p) => {
  console.log("Unhandled Rejection at: Promise ", p, " reason: ", reason);
});

process.on('warning', (warning) => {
  console.warn(warning.name);
  console.warn(warning.message);
  console.warn(warning.stack);
});

const positionDataBytes = new Uint8Array(new Float32Array([0.0, 0.0, 0.0]))

//const webServer = https.createServer({pfx: fs.readFileSync("cert.pfx"), passphrase: "vecmat.asm"}, (req, res) => {    //For localhost testing
const webServer = https.createServer({cert: fs.readFileSync("cert.pem"), key: fs.readFileSync("key.pem")}, (req, res) => {    //Running on Murmur server

  //We don"t expect to get HTTP requests, only WebSocket requests
  console.log("Warning: Received HTTP request on signaling server:", req.method, req.url)

}).listen(webRtcPort, () => {

  //Create WS server
  const wsServer = new WebSocket.Server({server: webServer});
  console.log("WebSocket listening on port", webRtcPort)

  wsServer.on("connection", webSocket => {
    let clientReady = false
    let murmurSocket = null
    let dataChannel = null
    let audioSink = null

    webSocket.sendJson = obj => webSocket.send(JSON.stringify(obj))

    const id = generateId()
    const log = (msg, ...args) => {
      if (logging) {
        console.log(`[${id}]`, msg, ...args)
      }
    }
    
    EstablishPeerConnection(webSocket, log, peerConnection => {

      peerConnection.ontrack = evt => {
        log("got track")
        audioSink = new RTCAudioSink(evt.track)
        audioSink.ondata = processAudioData
      }

      peerConnection.onClientReady = () => {
        clientReady = true
        maybeOpenMurmur()
      }
      
      const maybeOpenMurmur = () => {
        if (clientReady && dataChannel && (dataChannel.readyState === "open")) {
          murmurSocket = new tls.TLSSocket(net.createConnection(murmurPort, murmurHost, () => {
            murmurSocket.connected = true
    
            murmurSocket.on("end", () => {
              log("murmurSocket end"); 
              if (murmurSocket) {
                murmurSocket.connected = false
              }
              shutdown()
            })
          
            murmurSocket.on("error", err => {
              log("Error on Murmur socket:", err);
            });
          
            murmurSocket.on("data", data => {
              dataChannel.send(data)
            })
    
            webSocket.sendJson({type: "start"})
          }))
        }
      }

      //
      // Create connections
      //
    
      dataChannel = peerConnection.createDataChannel("dataChannel")

      dataChannel.onopen = () => {
        log(`dataChannel open (state = ${dataChannel.readyState})`)
        maybeOpenMurmur()
      }

      dataChannel.onmessage = evt => {
        if (murmurSocket && murmurSocket.connected) {
          murmurSocket.write(Buffer.from(evt.data))
        } else {
          log("Got dataChannel message before murmurSocket is connected")
        }
      }


      //
      // Shutdown
      //
    
      let shuttingDown = false
      const shutdown = () => {
        if (!shuttingDown) {
          shuttingDown = true
          log("shutdown")
          if (murmurSocket) {
            murmurSocket.end()
            murmurSocket = null
          }
          webSocket.close()
          if (dataChannel) {
            dataChannel.close()
            dataChannel = null
          }
          peerConnection.close()
        }
      }
    
      //
      // Handle disconnections & errors
      //
    
      dataChannel.onclose = shutdown
    
      dataChannel.onerror = err => {
        log("dataChannel error:", err)
      }
      
      //
      // Handle incoming data
      //
    
      //For encoding and sending audio data
      const opusEncoder = new opus.OpusEncoder(48000, 1)
      let rawDataBuffer = new Uint16Array(480 * 5)
      let rawDataBufferOffset = 0
      peerConnection.packetCount = 0
      let lastSampleCount
    
      const processAudioData = data => {
        if (!murmurSocket.connected) {
          return
        }
    
        if (data.samples.length > 480) {
          throw new Error("Too many samples in packet: " + data.samples.length)
        }
    
        if (lastSampleCount && (data.samples.length > lastSampleCount) && rawDataBufferOffset) {
          log("discarding (size change)", rawDataBufferOffset)
          rawDataBufferOffset = 0
        }
        lastSampleCount = data.samples.length

        new Uint16Array(rawDataBuffer.buffer, rawDataBufferOffset * 2, data.samples.length).set(data.samples)
        rawDataBufferOffset += data.samples.length
    
        if (rawDataBufferOffset > 1920) {
          log("discarding (too big)", rawDataBufferOffset)
          rawDataBufferOffset = 0
        }
    
        if (rawDataBufferOffset === 1920) {
    
          //Convert raw samples to Opus
          const encodedSamples = opusEncoder.encode(new Uint16Array(rawDataBuffer.buffer, 0, rawDataBufferOffset));
    
          //Build TCP tunnel packet
          const pds = new PacketDataStream(2 + 4 + 1 + 4 + 4 + encodedSamples.byteLength + 12)      //Allow for up to four bytes for varints
           
          pds.putInt16(1)                             //16-bit int: Packet type 1 = UDP Tunnel
          pds.skip(4)                                 //Leave space for 32-bit in packet length
          pds.putByte(128)                            //8-bit int: UDP packet header -- Packet type (OPUS) and target (0) 
          pds.putVarint(peerConnection.packetCount)   //Varint: Sequence number
          pds.putVarint(encodedSamples.byteLength)    //Varint: Length of the raw data
          pds.putBytes(encodedSamples)                //Byte arrray of encoded audio
          pds.putBytes(positionDataBytes)             //Byte array of position data.  May be optional.
          pds.putInt32(pds.offset - 6, 2)             //Save the packet length (less the type & length part) back at position 2 in the buffer
    
          //Send it off!
          murmurSocket.write(Buffer.from(new Uint8Array(pds.buffer.buffer, 0, pds.offset)))

          //Reset to start of buffer
          rawDataBufferOffset = 0
        }
        peerConnection.packetCount += 1
      }
    })
  })
})

//
// Utility functions
//

const digit0 = [15, 12, 5, 6, 4, 9, 0, 1, 2, 10, 13, 11, 3, 8, 14, 7]
const digit1 = [11, 3, 14, 4, 13, 1, 5, 7, 6, 8, 10, 9, 0, 15, 12, 2]
const digit2 = [15, 1, 8, 12, 5, 11, 6, 7, 10, 14, 4, 9, 13, 0, 3, 2]
const digit3 = [4, 11, 13, 2, 5, 3, 9, 6, 8, 15, 14, 1, 7, 10, 0, 12]

let counter0 = Math.floor(Math.random() * 16)
let counter1 = Math.floor(Math.random() * 16)
let counter2 = Math.floor(Math.random() * 16)
let counter3 = Math.floor(Math.random() * 16)

function generateId() {

  const result = (digit3[counter3].toString(16) + digit2[counter2].toString(16) + digit1[counter1].toString(16) + digit0[counter0].toString(16)).toUpperCase()

  counter0 = (counter0 + 1) % 16
  counter1 = (counter1 + 1) % 16
  counter2 = (counter2 + 1) % 16
  counter3 = (counter3 + 1) % 16

  if (counter0 === 0) {
    counter1++;
    if (counter1 === 16) {
      counter1 = 0
      counter2++
      if (counter2 === 16) {
        counter2 = 0
        counter3++
      }
    }
  }

  return result
}

