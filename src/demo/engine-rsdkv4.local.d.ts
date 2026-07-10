declare module '@wasm-gaming/engine-rsdkv4' {
	export interface Rsdkv4Instance {
		pause(): void;
		resume(): void;
		persistent: boolean;
		devMenu: {
			getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
		};
	}

	export function load(config: {
		canvas: HTMLCanvasElement;
		assets?: {
			data?: Uint8Array;
			settings?: Uint8Array;
		};
		dataProvider?: () => Promise<Uint8Array> | Uint8Array;
		onEvent?: (ev: any) => void;
		[key: string]: unknown;
	}): Promise<Rsdkv4Instance>;
}