'use strict';

const RTCPeerConnection = require('wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 20000;
const TIME_TO_RECONNECTED = 20000;

export default function EstablishPeerConnection(signalingSocket, log, beforeOffer) {
  let timeoutTimer

  const close = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer)
    }
    peerConnection.close()
  }

  const doSetTimeout = time => {
    timeoutTimer = setTimeout(() => {
      if ((peerConnection.iceConnectionState !== 'connected') && (peerConnection.iceConnectionState !== 'completed')) {
        close()
      }
    }, time)
  }

  const peerConnection = new RTCPeerConnection({
    sdpSemantics: "unified-plan",
    iceServers: [
      {
        'urls': 'stun:stun.l.google.com:19302'
      },
    ]
  });

  peerConnection.oniceconnectionstatechange = () => {
    log("iceConnectionState", peerConnection.iceConnectionState)
    if ((peerConnection.iceConnectionState === 'disconnected') || (peerConnection.iceConnectionState === 'failed')) {
      doSetTimeout(TIME_TO_RECONNECTED)
    }
  }

  peerConnection.onconnectionstatechange = () => {
    log("connectionState", peerConnection.connectionState)
    if ((peerConnection.connectionState === "disconnected") || (peerConnection.connectionState === "failed")) {
      close()
    }
  }

  peerConnection.onicegatheringstatechange = () => {
    log("iceGatheringState:", peerConnection.iceGatheringState)
  }

  peerConnection.onsignalingstatechange = () => {
    log("signalingState:", peerConnection.signalingState)
  }

  peerConnection.onnegotiationneeded = () => {
    log("onnegotiationneeded")
    peerConnection.createOffer()
    .then(offer => peerConnection.setLocalDescription(offer))
    .then(() => signalingSocket.sendJson({
      type: "offer",
      offer: peerConnection.localDescription
    }))
  }

  peerConnection.onicecandidate = evt => {
    if (evt.candidate && evt.candidate.candidate) {
      log("on icecandidate")  //, evt.candidate.candidate)
      signalingSocket.sendJson({
        type: "ice",
        ice: {
          candidate: evt.candidate.candidate,
          sdpMid: evt.candidate.sdpMid,
          sdpMLineIndex: evt.candidate.sdpMLineIndex
        }
      })
    }
  }

  beforeOffer(peerConnection)

  doSetTimeout(TIME_TO_CONNECTED)

  signalingSocket.on("message", msg => {
    const json = JSON.parse(msg)

    switch (json.type) {

      case "answer":
        log("answer received")
        peerConnection.setRemoteDescription(json.answer)
        break

      case "offer":
        log("offer received")
        peerConnection.setRemoteDescription(json.offer)
          .then(() => peerConnection.createAnswer())
          .then(answer => {
            peerConnection.setLocalDescription(answer)
              .then(() => {
                signalingSocket.sendJson({type: "answer", answer: answer})  //Should be able to send localDescription except for Firefox bug
              })
          })
        break;

      case "ice":
        log("adding iceCandidate")
        if (json.ice.candidate) {
          peerConnection.addIceCandidate(json.ice)
        }
        break

      case "ready":
        log("client ready")
        if (peerConnection.onClientReady) {
          peerConnection.onClientReady()
        }
        break

      case "close":
        log("closing peerConnection")
        close()
        break

      default:
        log("Unhandled signaling message type:", json.type)
    }
  })

  return peerConnection;
}
