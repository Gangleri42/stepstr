// glTF I/O that writes GLBs to memory and reads nothing, for places without network or file system, such as a
// sandboxed napplet. WebIO and NodeIO would pull in fetch and node:fs, which the napplet must not contain.
import { PlatformIO } from '@gltf-transform/core';

export class MemoryIO extends PlatformIO {
	protected async readURI(): Promise<never> {
		throw new Error('MemoryIO writes GLBs; it cannot read resources');
	}
	protected resolve(_base: string, path: string) {
		return path;
	}
	protected dirname() {
		return '';
	}
}
