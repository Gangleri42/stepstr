/**
 * Lets the event loop run everything already waiting (input, painting, the shell's messages) before continuing: the
 * continuation is an ordinary task at the back of the queue. Not scheduler.yield, whose continuations go ahead of
 * other tasks and can starve them through a long run of yields; not setTimeout, which background tabs throttle.
 */
export function yieldToHost(): Promise<void> {
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			resolve();
		};
		channel.port2.postMessage(0);
	});
}
