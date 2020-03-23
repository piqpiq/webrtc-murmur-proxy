"use strict"

import http from "http"
import textBody from "body"
import tls from "tls"
import net from "net"
import { nonstandard } from "wrtc"
import opus from "@discordjs/opus"
import WebRtcConnection from "./webrtcconnection"
const { v4: uuidv4 } = require('uuid');
const RTCAudioSink = nonstandard.RTCAudioSink

const murmurHost = "default.mumble.prod.hearo.live"
const murmurPort = 64738
const webRtcPort = 8136

console.log("Starting mummur-proxy")

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

const connections = new Map();

function createId() {
  do {
    const id = uuidv4();
    if (!connections.has(id)) {
      return id;
    }
  // eslint-disable-next-line
  } while (true);
}

const createConnection = beforeOffer => {
  const connection = new WebRtcConnection(createId(), beforeOffer);

  const closedListener = () => {
    connection.removeListener('closed', closedListener);
    connections.delete(connection.id);
  }

  connection.once('closed', closedListener);
  connections.set(connection.id, connection);

  return connection;
};

http.createServer({}, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")

  switch (req.method) {

    case "POST":
      if (req.url === "/connections") {
        try {
          const connection = createConnection(beforeOffer)
          connection.doOffer()
            .then(() => {
              res.end(JSON.stringify(connection))
              //console.log(`WebRTC connection from ${req.connection.remoteAddress}:${req.connection.remotePort}: ${connection.id}`)
            })
        } catch (error) {
          console.log("POST error")
          console.error(error);
          res.writeHead(500);
          res.end()
        }
        return
      } else {
        const connectionId = getConnectionId(req, /\/connections\/(.*?)\/remote-description/)
        if (connectionId) {
          const connection = getConnection(connectionId);
          if (!connection) {
            res.writeHead(404);
          } else {
            try {
              textBody(req, (err, body) => {
                connection.applyAnswer(JSON.parse(body))
                  .then(() => {
                    res.end(JSON.stringify(connection.remoteDescription));
                  })
              })
              return
            } catch (error) {
              console.log("Error:", error)
              res.writeHead(400);
            }
          }
          res.end()
          return
        }
      }
      break

    case "DELETE":
      const connectionId = getConnectionId(req, /\/connections\/(.*?)$/)
      if (connectionId) {
        const connection = getConnection(connectionId);
        if (!connection) {
          res.writeHead(404)
        } else {
          connection.close()
        }
        res.end()
        return;
      }    
      break

    case "OPTIONS":
      //CORS pre-flight response
      res.setHeader("Connection", "keep-alive")
      res.setHeader("Accept", "application/json")
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE")
      res.setHeader("Access-Control-Max-Age", "86400")
      res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, User-Agent")
      res.writeHead(204)
      res.end()
      return
  }

  console.log("Error: Unhandled request:", req.method, req.url)

}).listen(webRtcPort, () => {
  console.log("WebRTC listening on port", webRtcPort)
})
  
const getConnection = id => connections.get(id) || null

const getConnectionId = (req, regex) => {
  const match = req.url.match(regex)
  return (match.length === 2) ? match[1] : null
}

const positionDataBytes = new Uint8Array(new Float32Array([0.0, 0.0, 0.0]))

const beforeOffer = peerConnection => {
  peerConnection.packetCount = 0
  //console.log("got peerConnection") //, peerConnection)
  const opusEncoder = new opus.OpusEncoder(48000, 1)

  let rawDataBuffer = new Uint16Array(480 * 5)
  let rawDataBufferOffset = 0

  peerConnection.audioSink = new RTCAudioSink(peerConnection.addTransceiver('audio', ).receiver.track).ondata = data => {
    if (data.samples.length > 480) {
      throw new Error("Too many samples in packet: " + data.samples.length)
    }

    new Uint16Array(rawDataBuffer.buffer, rawDataBufferOffset * 2, data.samples.length).set(data.samples)
    rawDataBufferOffset += data.samples.length

    if (rawDataBufferOffset > 1920) {
      console.log("discarding", rawDataBufferOffset)
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

  //Create connection to Murmur server
  const murmurSocket = new tls.TLSSocket(net.createConnection(murmurPort, murmurHost, () => {
    //console.log(`Connected to ${murmurHost}:${murmurPort}`)
  }))

  murmurSocket.on("data", data => {
    if (peerConnection.dataChannel) {
      peerConnection.dataChannel.send(data)
    } else {
      console.log("dataChannel NOT YET OPEN")
    }
  })

  const shutdown = () => {
    peerConnection.audioSink.ondata = null
    const connection = getConnection(peerConnection.id)
    if (connection) {
      connection.close()
    }
    peerConnection.close()
  }

  murmurSocket.on("end", shutdown)

  murmurSocket.on("error", err => {
    console.log("Error on Murmur socket:", err);
    murmurSocket.end();
  });

  peerConnection.onconnectionstatechange = () => {
    //console.log("PeerConnection new connectionState:", peerConnection.connectionState)
    if ((peerConnection.connectionState === "disconnected") || (peerConnection.connectionState === "failed")) {
      shutdown()
    }
  }

  peerConnection.dataChannel = peerConnection.createDataChannel("dataChannel");
  //peerConnection.dataChannel.onopen = () => console.log("dataChannel open")
  peerConnection.dataChannel.onclose = shutdown
  peerConnection.dataChannel.onerror = err => console.log("dataChannel error:", err)
  peerConnection.dataChannel.onmessage = evt => {
    murmurSocket.write(Buffer.from(evt.data))
  }
}

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
