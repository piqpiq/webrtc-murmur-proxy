'use strict';

const EventEmitter = require('events');
const RTCPeerConnection = require('wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 20000;
const TIME_TO_HOST_CANDIDATES = 3000;
const TIME_TO_RECONNECTED = 20000;

export default class WebRtcConnection extends EventEmitter {
  constructor(id, beforeOffer) {
    super()
    this.id = id;
    this.state = 'open';

    const peerConnection = new RTCPeerConnection({
      sdpSemantics: 'unified-plan'
    });

    beforeOffer(peerConnection);

    let connectionTimer = setTimeout(() => {
      if ((peerConnection.iceConnectionState !== 'connected') && (peerConnection.iceConnectionState !== 'completed')) {
        this.close();
      }
    }, TIME_TO_CONNECTED);

    let reconnectionTimer = null;

    const onIceConnectionStateChange = () => {
      if ((peerConnection.iceConnectionState === 'connected') || (peerConnection.iceConnectionState === 'completed')) {
        if (connectionTimer) {
          clearTimeout(connectionTimer);
          connectionTimer = null;
        }
        clearTimeout(reconnectionTimer);
        reconnectionTimer = null;
      } else if ((peerConnection.iceConnectionState === 'disconnected') || (peerConnection.iceConnectionState === 'failed')) {
        if (!connectionTimer && !reconnectionTimer) {
          const self = this;
          reconnectionTimer = setTimeout(() => {
            self.close();
          }, TIME_TO_RECONNECTED);
        }
      }
    };

    peerConnection.addEventListener('iceconnectionstatechange', onIceConnectionStateChange);

    this.doOffer = async () => {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      try {
        await waitUntilIceGatheringStateComplete(peerConnection);
      } catch (error) {
        this.close();
        throw error;
      }
    };

    this.applyAnswer = async answer => {
      await peerConnection.setRemoteDescription(answer);
    };

    this.close = () => {
      peerConnection.removeEventListener('iceconnectionstatechange', onIceConnectionStateChange);
      if (connectionTimer) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
      }
      if (reconnectionTimer) {
        clearTimeout(reconnectionTimer);
        reconnectionTimer = null;
      }
      peerConnection.close();
      this.state = 'closed';
      this.emit('closed');
    };

    this.toJSON = () => {
      return {
        id: this.id,
        state: this.state,
        iceConnectionState: this.iceConnectionState,
        localDescription: this.localDescription,
        remoteDescription: this.remoteDescription,
        signalingState: this.signalingState
      };
    };

    Object.defineProperties(this, {
      iceConnectionState: {
        get() {
          return peerConnection.iceConnectionState;
        }
      },
      localDescription: {
        get() {
          return descriptionToJSON(peerConnection.localDescription, true);
        }
      },
      remoteDescription: {
        get() {
          return descriptionToJSON(peerConnection.remoteDescription);
        }
      },
      signalingState: {
        get() {
          return peerConnection.signalingState;
        }
      }
    });
  }
}

function descriptionToJSON(description, shouldDisableTrickleIce) {
  return !description ? {} : {
    type: description.type,
    sdp: shouldDisableTrickleIce ? disableTrickleIce(description.sdp) : description.sdp
  };
}

function disableTrickleIce(sdp) {
  return sdp.replace(/\r\na=ice-options:trickle/g, '');
}

async function waitUntilIceGatheringStateComplete(peerConnection) {
  if (peerConnection.iceGatheringState === 'complete') {
    return;
  }

  const deferred = {};
  deferred.promise = new Promise((resolve, reject) => {
    deferred.resolve = resolve;
    deferred.reject = reject;
  });

  const timeout = setTimeout(() => {
    console.log("timeToHostCandidates timeout")
    console.log("iceGatheringState:", peerConnection.iceGatheringState)
    peerConnection.removeEventListener('icecandidate', onIceCandidate);
    deferred.reject(new Error('Timed out waiting for host candidates'));
  }, TIME_TO_HOST_CANDIDATES);

  function onIceCandidate({ candidate }) {
    if (!candidate) {
      clearTimeout(timeout);
      peerConnection.removeEventListener('icecandidate', onIceCandidate);
      deferred.resolve();
    }
  }

  peerConnection.addEventListener('icecandidate', onIceCandidate);

  await deferred.promise;
}
