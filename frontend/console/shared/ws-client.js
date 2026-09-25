"use strict";
(() => {
  const createStream = (name, options = {}) => {
    let socket = null;
    let closed = false;
    const sequenceWatermarks = new Map();
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
      if (closed || !endpoint() || typeof WebSocket === "undefined") return false;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return true;
      try { socket = new WebSocket(endpoint()); }
      catch (error) { options.onError?.(error); scheduleReconnect(); return false; }
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        options.onState?.("connected");
        if (subscription) socket.send(JSON.stringify({ type: "subscribe", stream: name, ...subscription }));
      });
      socket.addEventListener("close", () => { if (!closed) options.onState?.("closed"); scheduleReconnect(); });
      socket.addEventListener("error", () => options.onState?.("error"));
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(event.data);
          const payload = frame?.data && typeof frame.data === "object" ? frame.data : frame?.payload && typeof frame.payload === "object" ? frame.payload : frame;
          const marketId = payload?.marketId ?? payload?.market_id ?? frame?.marketId ?? frame?.market_id ?? "";
          const roundId = payload?.roundId ?? payload?.round_id ?? frame?.roundId ?? frame?.round_id ?? "";
          const sequenceValue = payload?.sequence ?? frame?.sequence;
          const sequence = Number(sequenceValue);
          const sequenceValid = sequenceValue !== null && sequenceValue !== undefined && sequenceValue !== "" && typeof sequenceValue !== "boolean" && Number.isFinite(sequence) && sequence >= 0;
          const watermarkKey = `${String(marketId)}\u0000${String(roundId)}`;
          const previous = sequenceWatermarks.get(watermarkKey);
          if (options.requireSequence === true && !sequenceValid) return;
          if (Number.isFinite(sequence) && previous != null && sequence <= previous) return;
          if (typeof options.acceptFrame === "function" && !options.acceptFrame(frame)) return;
          if (sequenceValid) sequenceWatermarks.set(watermarkKey, sequence);
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
