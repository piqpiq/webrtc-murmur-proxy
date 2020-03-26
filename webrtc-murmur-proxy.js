"use strict"

import http from "http"
import jsonBody from "body/json"
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
          const murmurSocket = new tls.TLSSocket(net.createConnection(murmurPort, murmurHost, () => {
            murmurSocket.connected = true
            const connection = createConnection(peerConnection => setupPeerConnection(peerConnection, murmurSocket))
            connection.doOffer()
              .then(() => {
                res.end(JSON.stringify(connection))
              })
          }))
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
            res.end()
          } else {
            try {
              jsonBody(req, (err, body) => {
                connection.onDescriptionReceived(body)
                  .then(() => {
                    res.setHeader("Content-Type","application/json")
                    res.end(JSON.stringify(connection.localDescription))
                    return
                  })
              })
            } catch (error) {
              console.log("Error:", error)
              res.writeHead(400);
              res.end()
            }
          }
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

const setupPeerConnection = (peerConnection, murmurSocket) => {

  const log = (msg, ...args) => {
    if (logging) {
      console.log(`[${peerConnection.id.substring(0, 8)}]`, msg, ...args)
    }
  }

  //
  // Create connections
  //

  const audioSink = new RTCAudioSink(peerConnection.addTransceiver('audio', {direction: "recvonly"}).receiver.track)

  peerConnection.dataChannel = peerConnection.createDataChannel("dataChannel")
  peerConnection.dataChannel.onopen = () => {
    log("dataChannel open")
  }

  //
  // Shutdown
  //

  let shuttingDown = false
  const shutdown = () => {
    if (!shuttingDown) {
      shuttingDown = true
      log("shutdown")
      const connection = getConnection(peerConnection.id)
      if (connection) {
        log("closing")
        connection.close()
      }
    }
  }

  //
  // Handle disconnections & errors
  //

  murmurSocket.on("end", () => {
    log("murmurSocket end"); 
    murmurSocket.connected = false
    shutdown()
  })

  murmurSocket.on("error", err => {
    log("Error on Murmur socket:", err);
  });

  peerConnection.onconnectionstatechange = () => {
    log("peerConnection", peerConnection.connectionState)
    if ((peerConnection.connectionState === "disconnected") || (peerConnection.connectionState === "failed")) {
      shutdown()
    }
  }

  peerConnection.onnegotiationneeded = () => {
    log("peerConnection negotiationneed")
  }
  
  peerConnection.dataChannel.onclose = shutdown

  peerConnection.dataChannel.onerror = err => {
    log("dataChannel error:", err)
  }
 
  //
  // Handle incoming data
  //

  murmurSocket.on("data", data => {
    if (peerConnection.dataChannel.readyState === "open") {
      peerConnection.dataChannel.send(data)
    }
  })

  peerConnection.dataChannel.onmessage = evt => {
    if (murmurSocket.connected) {
      murmurSocket.write(Buffer.from(evt.data))
    }
  }

  //For encoding and sending audio data
  const opusEncoder = new opus.OpusEncoder(48000, 1)
  let rawDataBuffer = new Uint16Array(480 * 5)
  let rawDataBufferOffset = 0
  peerConnection.packetCount = 0

  audioSink.ondata = data => {
    if (!murmurSocket.connected) {
      return
    }

    if (data.samples.length > 480) {
      throw new Error("Too many samples in packet: " + data.samples.length)
    }

    new Uint16Array(rawDataBuffer.buffer, rawDataBufferOffset * 2, data.samples.length).set(data.samples)
    rawDataBufferOffset += data.samples.length

    if (rawDataBufferOffset > 1920) {
      log("discarding", rawDataBufferOffset)
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
}

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
