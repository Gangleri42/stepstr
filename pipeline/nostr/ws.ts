// nostr-tools talks to relays through the global WebSocket, which in Node is undici's. When a relay accepts the TCP
// connection but never finishes the handshake, that pair recurses (error handler closes the socket, closing fires
// the error handler …) until the stack overflows and the process dies. The ws package does not, so every script
// imports this module before it opens a pool.
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

class RelaySocket extends WebSocket {
	constructor(url: string | URL) {
		super(url, { headers: { 'User-Agent': 'stepstr (nostr-tools)' }, handshakeTimeout: 10_000 });
		// nostr-tools closes a socket whose connection timed out and detaches its handlers first; ws then emits
		// "closed before the connection was established" as an 'error' event, which is fatal when nothing listens.
		this.on('error', () => undefined);
	}
}

useWebSocketImplementation(RelaySocket);

// A relay dropping a connection mid-publish is reported per relay by the code that talks to it; it must not end
// the process. Anything else is still a bug and still fatal.
const relayNoise = /websocket|connection|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|timed out/i;
process.on('unhandledRejection', (reason) => {
	const message = reason instanceof Error ? reason.message : String(reason);
	if (relayNoise.test(message)) console.warn(`relay: ${message}`);
	else throw reason;
});
