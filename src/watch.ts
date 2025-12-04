// src/watch.ts

import { Connection, LogsCallback, Logs } from "@solana/web3.js";
import { printPumpGuardBanner } from "./banner";

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

interface PumpGuardTx {
	slot: number;
	signature: string;
	time: string;
}

export async function runWatch(): Promise<void> {
	printPumpGuardBanner("watch");

	const rpc = process.env.RPC_ENDPOINT;
	const maxQueue = Number(process.env.MINT_QUEUE_MAX ?? "2000");

	if (!rpc) {
		console.error("❌ RPC_ENDPOINT is not set. Set it first, e.g.:");
		console.error('   $env:RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE"');
		process.exit(1);
	}

	console.log("🔌 Connecting to Solana RPC endpoint:");
	console.log(`   ${rpc}`);
	console.log("");

	const connection = new Connection(rpc, "confirmed");

	try {
		const epochInfo = await connection.getEpochInfo();
		console.log("✅ Connected to Solana mainnet.");
		console.log(`   Current absolute slot: ${epochInfo.absoluteSlot}`);
		console.log("");
	} catch (err) {
		console.error("❌ Failed to talk to Solana RPC:");
		console.error(err);
		process.exit(1);
	}

	console.log("🛡  PumpGuard WATCH mode (Phase 2) is live.");
	console.log(`   Pump.fun program: ${PUMP_FUN_PROGRAM_ID}`);
	console.log(`   Max queue size:  ${maxQueue}`);
	console.log("");
	console.log("👁  Subscribing to Pump.fun logs…");
	console.log("    Press Ctrl+C to terminate.");
	console.log("");

	const queue: PumpGuardTx[] = [];

	const onLogs: LogsCallback = (logs: Logs, ctx) => {
		const signature = logs.signature;
		const slot = logs.slot;
		const time = new Date().toISOString();

		queue.push({ slot, signature, time });
		if (queue.length > maxQueue) {
			queue.shift();
		}

		console.log("-------------------------------------------");
		console.log("🧾 Pump.fun tx detected (queued):");
		console.log(`  Time: ${time}`);
		console.log(`  Slot: ${slot}`);
		console.log(`  Sig : ${signature}`);
		console.log(`  Queue length: ${queue.length} (max ${maxQueue})`);
	};

	const subId = await connection.onLogs(PUMP_FUN_PROGRAM_ID, onLogs, "confirmed");

	console.log(`📡 Subscribed to Pump.fun logs. Subscription ID: ${subId}`);
	console.log("🧬 Phase 2: live stream + queue online. Mint lookups & risk brain come in Phase 3.");
	console.log("");

	await new Promise<void>(() => {
		// intentionally never resolve
	});
}
