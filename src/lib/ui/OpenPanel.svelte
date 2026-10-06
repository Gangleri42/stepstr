<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ABOUT } from '$lib/about';
	import type { RecentEntry } from '$lib/recent/types';

	type Props = {
		/** A problem with the last attempt, and what could help: the file from this device, or the web viewer. */
		error: { message: string; hint?: 'local' | 'web' } | null;
		/** Files viewed before on this device, newest first. */
		recent: RecentEntry[];
		onRecent: (entry: RecentEntry) => void;
		onForget: (key: string) => Promise<void>;
		onClearRecent: () => Promise<void>;
		/** Whether a model is on screen, so the panel can be closed. */
		closable: boolean;
		onText: (text: string) => void;
		onFile: (file: File) => void;
		/** The host's own file picker, when the page cannot show one. */
		onPick?: () => void;
		onWeb?: () => void;
		onClose: () => void;
	};
	let { error, recent, onRecent, onForget, onClearRecent, closable, onText, onFile, onPick, onWeb, onClose }: Props = $props();

	let text = $state('');
	let input: HTMLInputElement;
	let title: HTMLHeadingElement;
	let cards = $state<HTMLUListElement>();
	let cancel = $state<HTMLButtonElement>();
	/** Clear asks first: it removes the list and every model and file kept for it. */
	let confirming = $state(false);

	function choose() {
		if (onPick) onPick();
		else input.click();
	}

	/** Removes one entry; the focus goes to the card that takes its place, or the one before. */
	async function forget(index: number, key: string) {
		await onForget(key);
		await tick();
		const left = cards?.querySelectorAll<HTMLButtonElement>('button.card');
		(left?.[Math.min(index, left.length - 1)] ?? title).focus();
	}
	async function confirm() {
		confirming = true;
		await tick();
		cancel?.focus();
	}
	async function clear() {
		confirming = false;
		await onClearRecent();
		await tick();
		title.focus();
	}

	const size = (bytes: number) => (bytes < 1e5 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`);
	const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	/** Refreshed every half minute so the times in the list move on while the panel stays open. */
	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	/** How long ago, in the largest unit that fits; past a week, the date, with the year when it is not this one. */
	function ago(time: number) {
		const seconds = (now - time) / 1000;
		if (seconds < 60) return 'just now';
		if (seconds < 3600) return relative.format(-Math.floor(seconds / 60), 'minute');
		if (seconds < 86400) return relative.format(-Math.floor(seconds / 3600), 'hour');
		if (seconds < 7 * 86400) return relative.format(-Math.floor(seconds / 86400), 'day');
		const date = new Date(time);
		const year = date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric';
		return date.toLocaleDateString('en', { day: 'numeric', month: 'short', year });
	}
</script>

<div class="open" role="dialog" aria-labelledby="open-title">
	<div class="head">
		<h1 id="open-title" tabindex="-1" bind:this={title}>Open a STEP file</h1>
		{#if closable}
			<button class="close" onclick={onClose} aria-label="Close">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
			</button>
		{/if}
	</div>
	<p class="lead">Any STEP file, converted right here: its parts, section cuts, exploded views and exact measurements.</p>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			if (text.trim()) onText(text);
		}}
	>
		<input type="text" bind:value={text} placeholder="Paste a link: GitHub, https, blossom:, nevent…" aria-label="Link to a STEP file" spellcheck="false" autocomplete="off" />
		<button type="submit" disabled={!text.trim()}>Open</button>
	</form>
	<p class="choose">
		Drop a file anywhere, paste one, or <button class="link" onclick={choose}>choose a file</button>.
	</p>
	<input
		bind:this={input}
		type="file"
		hidden
		accept=".step,.stp,.p21,.zip,.gz,model/step"
		onchange={(e) => {
			const file = e.currentTarget.files?.[0];
			if (file) onFile(file);
			e.currentTarget.value = '';
		}}
	/>
	{#if error}
		<div class="error" role="alert">
			<p>{error.message}</p>
			{#if error.hint === 'local'}
				<button onclick={choose}>Choose the file on this device</button>
			{:else if error.hint === 'web' && onWeb}
				<button onclick={onWeb}>Open it in the web viewer</button>
			{/if}
		</div>
	{/if}
	{#if recent.length}
		<section class="recent" aria-labelledby="recent-title">
			<div class="recent-head">
				<h2 id="recent-title">Recently viewed</h2>
				{#if confirming}
					<span class="ask">Remove all from this device?</span>
					<button class="link" onclick={clear}>Remove all</button>
					<button class="link" bind:this={cancel} onclick={() => (confirming = false)}>Cancel</button>
				{:else}
					<button class="link" onclick={confirm}>Clear</button>
				{/if}
			</div>
			<ul bind:this={cards}>
				{#each recent as entry, i (entry.key)}
					<li>
						<button class="card" onclick={() => onRecent(entry)} title={entry.name}>
							{#if entry.thumbnail}
								<img src={entry.thumbnail} alt="" />
							{:else}
								<span class="blank" aria-hidden="true"></span>
							{/if}
							<span class="card-name">{entry.name}</span>
							<span class="card-meta">{size(entry.size)} · {ago(entry.viewedAt)}</span>
						</button>
						<button class="forget" onclick={() => forget(i, entry.key)} aria-label="Remove {entry.name} from this list" title="Remove from this list">
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 6l8 8M14 6l-8 8" /></svg>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
	<p class="note">Nothing is uploaded: files are converted on this device, and the list of recent ones stays here too.</p>
	<details class="about">
		<summary>About</summary>
		<p>
			stepstr is in the public domain. It converts files with Open CASCADE Technology, used under the LGPL 2.1 with the Open
			CASCADE exception; the converter's source and build script are part of stepstr's source{#if ABOUT.source}, <code>{ABOUT.source}</code>{/if}.
		</p>
		{#if ABOUT.converter}
			<p>Converter build: sha256 <code>{ABOUT.converter}</code></p>
		{/if}
	</details>
</div>

<style>
	.open {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		width: min(460px, calc(100vw - 24px));
		max-height: calc(100dvh - 24px);
		overflow-y: auto;
		box-sizing: border-box;
		padding: 20px 20px 16px;
		border-radius: 16px;
		background: var(--surface);
		border: 1px solid var(--line);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		box-shadow: var(--shadow);
		z-index: 5;
		display: grid;
		gap: 12px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	h1 {
		font-size: 17px;
		font-weight: 650;
		margin: 0 auto 0 0;
		letter-spacing: 0.01em;
	}
	h1:focus {
		outline: none;
	}
	.close {
		border: 0;
		background: none;
		color: var(--muted);
		cursor: pointer;
		padding: 4px;
		border-radius: 8px;
	}
	.close:hover {
		background: var(--hover);
	}
	svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
	}
	.lead,
	.choose,
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.45;
	}
	.note {
		font-size: 12px;
	}
	.about {
		font-size: 12px;
		color: var(--muted);
	}
	.about summary {
		cursor: pointer;
		width: fit-content;
	}
	.about p {
		margin: 6px 0 0;
		line-height: 1.45;
	}
	.about code {
		font-size: 11px;
		word-break: break-all;
	}
	form {
		display: flex;
		gap: 6px;
	}
	input[type='text'] {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 13px;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line-strong);
		border-radius: 10px;
		padding: 9px 11px;
	}
	input[type='text']:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	form button,
	.error button {
		font: inherit;
		font-weight: 600;
		font-size: 13px;
		color: #fff;
		background: var(--accent);
		border: 0;
		border-radius: 10px;
		padding: 0 14px;
		cursor: pointer;
	}
	form button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.link {
		font: inherit;
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent-text);
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.error {
		display: grid;
		gap: 8px;
		justify-items: start;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--accent-soft);
		font-size: 13px;
	}
	.error p {
		margin: 0;
		line-height: 1.45;
	}
	.error button {
		padding: 7px 12px;
	}
	.recent {
		display: grid;
		gap: 8px;
	}
	.recent-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		font-size: 12px;
	}
	.ask {
		color: var(--muted);
	}
	h2 {
		margin: 0 auto 0 0;
		font-size: 13px;
		font-weight: 600;
	}
	.recent ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(124px, 1fr));
		gap: 10px;
	}
	.recent li {
		position: relative;
		min-width: 0;
	}
	.card {
		width: 100%;
		display: grid;
		gap: 3px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 10px;
	}
	.card img,
	.blank {
		display: block;
		width: 100%;
		aspect-ratio: 4 / 3;
		object-fit: cover;
		border-radius: 10px;
		border: 1px solid var(--line);
		background: var(--viewport);
		box-sizing: border-box;
	}
	.card:hover img,
	.card:hover .blank {
		border-color: var(--line-strong);
	}
	.card-name {
		font-size: 12px;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card-meta {
		font-size: 11px;
		color: var(--muted);
	}
	.forget {
		position: absolute;
		top: 4px;
		right: 4px;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 50%;
		background: var(--surface-solid);
		color: var(--muted);
		cursor: pointer;
		opacity: 0;
	}
	.forget svg {
		width: 14px;
		height: 14px;
	}
	.recent li:hover .forget,
	.forget:focus-visible {
		opacity: 1;
	}
	/* No hover on a touch screen: the remove buttons always show, and take a finger's width around them. */
	@media (hover: none) {
		.forget {
			opacity: 1;
		}
	}
	@media (pointer: coarse) {
		.forget::after {
			content: '';
			position: absolute;
			inset: -9px;
		}
	}
</style>
