"use strict";
(() => {
  const createStream = (name, options = {}) => {
    let socket = null;
    let closed = false;
    let lastSequence = -1;
    const connect = () => {
      if (closed || !options.url || window.PolyPreview?.config.mode === "local-preview" || typeof WebSocket === "undefined") return false;
      socket = new WebSocket(options.url);
      socket.addEventListener("open", () => options.onState?.("connected"));
      socket.addEventListener("close", () => options.onState?.("closed"));
      socket.addEventListener("error", () => options.onState?.("error"));
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(event.data);
          const sequence = Number(frame.sequence);
          if (Number.isFinite(sequence) && sequence <= lastSequence) return;
          if (Number.isFinite(sequence)) lastSequence = sequence;
          options.onMessage?.(frame);
        } catch (error) { options.onError?.(error); }
      });
      return true;
    };
    const subscribe = (payload) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", stream: name, ...payload })); };
    const close = () => { closed = true; socket?.close(); socket = null; };
    return { connect, subscribe, close };
  };
  window.PolyPreviewStreams = Object.freeze({ createStream });
})();
