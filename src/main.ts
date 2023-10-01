import {
	SimplePool,
	nip19,
	finishEvent,
} from 'nostr-tools';
import 'websocket-polyfill';
import {
	AppBskyFeedPost,
	BskyAgent,
	RichText
} from '@atproto/api';

const isDebug = false;

(async() => {
	const saveFileName = 'save.json';
	const fs = require('fs');
	const obj = JSON.parse(fs.readFileSync(saveFileName, 'utf8'));
	const latestTime = obj.latestTime;
	const NOSTR_PRIVATE_KEY = process.env.NOSTR_PRIVATE_KEY ?? '';
	const BLUESKY_IDENTIFIER = process.env.BLUESKY_IDENTIFIER ?? '';
	const BLUESKY_PASSWORD = process.env.BLUESKY_PASSWORD ?? '';
	const [message, latestTimeNew, urls] = await getMessage(obj.feedUrl, obj.hashTag, latestTime);
	if (message !== '') {
		if (!isDebug) {
			const {type, data} = nip19.decode(NOSTR_PRIVATE_KEY);
			const sk: string = type  === 'nsec' ? data : '';
			await postNostr(sk, message, obj.relays, urls, obj.hashTag);
			await postBluesky(BLUESKY_IDENTIFIER, BLUESKY_PASSWORD, message);
		}
		else {
			console.log('message length: ', message.length);
		}
		console.log('post complete');
		obj.latestTime = latestTimeNew;
		if (!isDebug) {
			fs.writeFileSync(saveFileName, JSON.stringify(obj, null, '\t'));
		}
		console.log('save complete');
	}
	else {
		console.log('not updated.');
	}

	// Nostrに投稿
	async function postNostr(sk: string, message: string, relays: string[], urls: string[], hashTag: string) {
		const pool = new SimplePool({eoseSubTimeout: 60, getTimeout: 60});
		const tags = [['t', hashTag]].concat(urls.map(url => ['r', url]));
		const unsignedEvent = {
			kind: 1,
			pubkey: '',
			created_at: Math.floor(Date.now() / 1000),
			tags: tags,
			content: message,
		};
		const signedEvent = finishEvent(unsignedEvent, sk)
		const pubs = pool.publish(relays, signedEvent);
		await Promise.all(pubs);
		pool.close(relays);
	}

	// Blueskyに投稿
	async function postBluesky(identifier: string, password:string, text: string) {
		const imageUrlMatch = text.match(/https?:\/\/.+\.(png|jpe?g|gif|bmp|webp)/i);
		let imageData;
		if (imageUrlMatch) {
			const imageUrl = imageUrlMatch[0];
			const res = await fetch(imageUrl);
			const buffer = await res.arrayBuffer();
			imageData = new Uint8Array(buffer);
			text = text.replace(imageUrl + '\n', '');
		}
		const agent = new BskyAgent({service: 'https://bsky.social'});
		await agent.login({
			identifier,
			password
		});
		let embed;
		if (imageData) {
			const uploadedRes = await agent.uploadBlob(imageData, {
				encoding: "image/png",
			});
			embed = {
				$type: "app.bsky.embed.images",
				images: [{
					"alt": '',
					"image": uploadedRes.data.blob,
				}],
			}
		}
		const rt = new RichText({text});
		await rt.detectFacets(agent);
		const postRecord: AppBskyFeedPost.Record = {
			$type: 'app.bsky.feed.post',
			text: rt.text,
			facets: rt.facets,
			createdAt: new Date().toISOString(),
		};
		if (embed) {
			postRecord.embed = embed;
		}
		const res = await agent.post(postRecord);
		console.log(res);
	}

	// JSON Feedを見に行って新着情報を取得
	async function getMessage(feedUrl: string, hashTag: string, latestTime: number): Promise<[string, number, string[]]> {
		let latestTimeNew = latestTime;
		const urls: Set<string> = new Set();
		const messagePre: Set<string> = new Set();
		const message: Set<string> = new Set();
		const feedStr = await fetch(feedUrl);
		const feed = JSON.parse(await feedStr.text());
		for (const item of feed.items.reverse()) {
			const pubDateStr: string = item.date_published ?? '';
			const pubDate: number = Date.parse(pubDateStr) / 1000;
			if (pubDate > latestTime) {
				const dateTime: Date = new Date((pubDate + 9 * 60 * 60) * 1000);
				const entry = [];
				entry.push(item.title);
				entry.push(item.content_text);
				entry.push(dateTime.toLocaleString('ja-JP'));
				entry.push(item.url);
				if (item.image)
					entry.push(item.image);
				entry.push('');
				messagePre.add(entry.join('\n'));
				if (Array.from(messagePre).join('\n').length > 280)
					break;
				message.add(entry.join('\n'));
				if (item.url)
					urls.add(item.url);
			}
			if (latestTimeNew < pubDate) {
				latestTimeNew = pubDate;
			}
			// 1件ずつ投稿することにする
			if (message.size > 0) {
				break;
			}
		}
		if (message.size > 0) {
			message.add('#' + hashTag);
			console.log(Array.from(message).join('\n'));
		}
		console.log('latestTime: ', latestTime);
		console.log('latestTimeNew: ', latestTimeNew);
		return [Array.from(message).join('\n'), latestTimeNew, Array.from(urls)];
	}
})();
