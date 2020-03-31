"use strict"

import WebSocket from "ws"
import tls from "tls"
import net from "net"
import { nonstandard } from "wrtc"
import opus from "@discordjs/opus"
import EstablishPeerConnection from "./webrtcconnection"
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

//Create WS server
const wsServer = new WebSocket.Server({port: webRtcPort});
console.log("WebSocket listening on port", webRtcPort)

wsServer.on("connection", webSocket => {
  let clientReady = false
  let murmurSocket = null
  let dataChannel = null

  webSocket.sendJson = obj => webSocket.send(JSON.stringify(obj))

  const id = generateId()
  const log = (msg, ...args) => {
    if (logging) {
      console.log(`[${id}]`, msg, ...args)
    }
  }
  
  EstablishPeerConnection(webSocket, log, peerConnection => {

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
  
    const audioSink = new RTCAudioSink(peerConnection.addTransceiver('audio', {direction: "recvonly"}).receiver.track)
  
    dataChannel = peerConnection.createDataChannel("dataChannel")

    dataChannel.onopen = () => {
      log(`dataChannel open (state = ${dataChannel.readyState})`)
      maybeOpenMurmur()
    }

    dataChannel.onmessage = evt => {
      if (murmurSocket && murmurSocket.connected) {
        murmurSocket.write(Buffer.from(evt.data))
      } else {
        log("Got dataChannel bessage before murmurSocket is connected")
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
  
    audioSink.ondata = data => {
      if (!murmurSocket.connected) {
        return
      }
  
      if (data.samples.length > 480) {
        throw new Error("Too many samples in packet: " + data.samples.length)
      }
  
      if (lastSampleCount && (data.samples.length > lastSampleCount)) {
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
        rawDataBufferOffset = 0
  
        const samplesLength = encodedSamples.byteLength
        const sequenceCountLength = writeVarintToByteArray(peerConnection.packetCount)
        const sampleByteCountLength = writeVarintToByteArray(samplesLength)
        
        //Build TCP tunnel packet
        const packet = new Uint8Array(2 + 4 + 1 + sequenceCountLength + sampleByteCountLength + samplesLength + 12)
  
        //Packet type 1 = UDP Tunnel
        writeInt16ToByteArray(1, packet, 0)
  
        //Length of UDP packet
        writeInt32ToByteArray(1 + sequenceCountLength + sampleByteCountLength + samplesLength + 12 , packet, 2)
  
        //UDP packet header: Packet type (OPUS) and target (0) 
        packet[6] = 128
  
        //Sequence number
        writeVarintToByteArray(peerConnection.packetCount, packet, 7)
        
        //Length of the raw data
        writeVarintToByteArray(samplesLength, packet, 7  + sequenceCountLength)
  
        //The raw data
        new Uint8Array(packet.buffer, 7 + sequenceCountLength + sampleByteCountLength, samplesLength).set(encodedSamples)
  
        //Positional data 
        new Uint8Array(packet.buffer, 7 + sequenceCountLength + sampleByteCountLength + samplesLength, 12).set(positionDataBytes)
  
        //Send it off!
        murmurSocket.write(Buffer.from(new Uint8Array(packet.buffer, 0, 7 + sequenceCountLength + sampleByteCountLength + samplesLength + 12)))
      }
      peerConnection.packetCount += 1
    }
  })
})

//
// Utility functions
//

function writeIntToByteArray(int, intLength, byteArray, offset) {
  for (let i = intLength; i > 0;) {
      i--
      var byte = int & 0xff;
      byteArray[offset + i] = byte;
      int = (int - byte) / 256 ;
  }
}

function writeInt32ToByteArray(int, byteArray, offset) {
  return writeIntToByteArray(int, 4, byteArray, offset)
}

function writeInt16ToByteArray(int, byteArray, offset) {
  return writeIntToByteArray(int, 2, byteArray, offset)
}

//Returns number of bytes written. If byteArray not specified, return just the byte count.
function writeVarintToByteArray(int, byteArray, offset) {

  if (int < 128) {
    if (byteArray) {
      byteArray[offset] = int
    }
    return 1
  } else if (int < 16384) {
    if (byteArray) {
      byteArray[offset] = int / 256 + 128
      byteArray[offset + 1] = int & 255
    }
    return 2
  } else if (int < 2097152) {
    if (byteArray) {
      byteArray[offset] = int / 65536 + 192
      byteArray[offset + 1] = (int / 256) & 255
      byteArray[offset + 2] = int & 255
    }
    return 3
  } else if (int < 268435456) {
    if (byteArray) {
      byteArray[offset] = int / 16777216 + 224
      byteArray[offset + 1] = (int / 65536) & 255
      byteArray[offset + 2] = (int / 256) & 255
      byteArray[offset + 3] = int & 255
    }
    return 4
  }
}

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

