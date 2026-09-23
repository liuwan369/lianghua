"use strict";
(() => {
  const createStream = (name, options = {}) => {
    let socket = null;
    let closed = false;
    let lastSequence = -1;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let subscription = null;
    const reconnect = options.reconnect !== false;
    const maxBackoff = Math.max(1000, Number(options.maxBackoffMs) || 15000);
    const endpoint = () => {
      if (!options.url) return null;
      try { return new URL(options.url, window.location.href).toString().replace(/^http/, "ws"); }
      catch { return options.url; }
    };
    const scheduleReconnect = () => {
      if (closed || !reconnect || reconnectTimer || !endpoint()) return;
      const delay = Math.min(maxBackoff, 500 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };
    const connect = () => {
      if (closed || !endpoint() || window.PolyPreview?.config.mode === "local-preview" || typeof WebSocket === "undefined") return false;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return true;
      try { socket = new WebSocket(endpoint()); }
      catch (error) { options.onError?.(error); scheduleReconnect(); return false; }
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        lastSequence = -1;
        options.onState?.("connected");
        if (subscription) socket.send(JSON.stringify({ type: "subscribe", stream: name, ...subscription }));
      });
      socket.addEventListener("close", () => { options.onState?.("closed"); scheduleReconnect(); });
      socket.addEventListener("error", () => options.onState?.("error"));
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(event.data);
          const sequence = Number(frame.sequence);
          if (Number.isFinite(sequence) && sequence <= lastSequence) return;
          if (Number.isFinite(sequence)) lastSequence = sequence;
          if (typeof options.acceptFrame === "function" && !options.acceptFrame(frame)) return;
          options.onMessage?.(frame);
        } catch (error) { options.onError?.(error); }
      });
      return true;
    };
    const subscribe = (payload = {}) => {
      subscription = payload;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", stream: name, ...payload }));
    };
    const close = () => { closed = true; if (reconnectTimer) window.clearTimeout(reconnectTimer); reconnectTimer = null; socket?.close(); socket = null; };
    return { connect, subscribe, close };
  };
  window.PolyPreviewStreams = Object.freeze({ createStream });
})();
