// src/index.ts
//
// PumpGuard CLI
// Commands:
//   npm run watch       -> live monitor Pump.fun launches and log them (with mint, rate-limited with max queue)
//   npm run report      -> show launches + stats from the log file
//   npm run export      -> write all launches to pumpguard-report.csv (with mint)
//   npm run export-tsv  -> write all launches to pumpguard-report.tsv (with mint)
//   npm run sniffer     -> same as watch (alias)
//   npm run scanner     -> same as watch (alias)

import { Connection, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

// ---------------- CONFIG ----------------

// Log file path (next to your project root)
const LOG_FILE = path.join(__dirname, "..", "pumpguard-launches.log");

// Default Solana mainnet endpoint
const RPC_ENDPOINT =
  process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";

// Rate limit for mint lookups (transactions per second).
// You can override this with env var MINT_FETCH_RPS.
const MINT_FETCH_RPS: number = (() => {
  const raw = process.env.MINT_FETCH_RPS;
  const n = raw ? Number(raw) : 3; // default 3 tx/s
  if (!Number.isFinite(n) || n <= 0) return 3;
  return n;
})();

// Maximum number of transactions we keep in the mint lookup queue.
// When the queue hits this size, we drop the oldest pending item
// before pushing a new one. You can override with MINT_QUEUE_MAX.
const MINT_QUEUE_MAX: number = (() => {
  const raw = process.env.MINT_QUEUE_MAX;
  const n = raw ? Number(raw) : 2000; // default cap: 2000 pending tx
  if (!Number.isFinite(n) || n <= 100) return 2000;
  return n;
})();

// Pump.fun program ID (this is the program you saw in your logs)
const PUMPFUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

// ---------------- TYPES & HELPERS ----------------

type LaunchLogEntry = {
  ts: string; // ISO timestamp
  slot: number;
  signature: string;
  url: string;
  mint?: string | null; // token mint (if we can detect it)
};

type PendingTx = {
  ts: string;
  slot: number;
  signature: string;
};

// Write one launch line to the log file.
// Format (new):
//   [ts] slot=... sig=... mint=... url=...
// Old lines without mint= still work.
function appendLaunch(entry: LaunchLogEntry) {
  const mintPart = entry.mint ? ` mint=${entry.mint}` : "";
  const line = `[${entry.ts}] slot=${entry.slot} sig=${entry.signature}${mintPart} url=${entry.url}`;
  fs.appendFileSync(LOG_FILE, line + "\n", "utf8");
}

// Parse one line from the log file back into an object.
// Supports both:
//   [ts] slot=... sig=... url=...
//   [ts] slot=... sig=... mint=... url=...
function parseLogLine(line: string): LaunchLogEntry | null {
  const regex =
    /^\[(.+?)\]\s+slot=(\d+)\s+sig=([^\s]+)(?:\s+mint=([^\s]+))?\s+url=(\S+)/;
  const m = line.trim().match(regex);
  if (!m) return null;

  const [, ts, slotStr, sig, mintMaybe, url] = m;
  return {
    ts,
    slot: Number(slotStr),
    signature: sig,
    url,
    mint: mintMaybe ?? null,
  };
}

// Read all lines from the log file, if it exists
function readAllEntries(): LaunchLogEntry[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const raw = fs.readFileSync(LOG_FILE, "utf8");
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const entries: LaunchLogEntry[] = [];
  for (const line of lines) {
    const parsed = parseLogLine(line);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

// ---------------- CSV / TSV HELPERS ----------------

// Proper CSV escaping: wrap in quotes if needed, escape inner quotes.
function csvEscape(value: string): string {
  if (
    value.includes('"') ||
    value.includes(",") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}

// Simple TSV escape: replace tabs and newlines with spaces.
function tsvEscape(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

// ---------------- MINT LOOKUP WORKER (RATE-LIMITED) ----------------

function startMintWorker(connection: Connection, queue: PendingTx[]) {
  const intervalMs = Math.max(1000 / MINT_FETCH_RPS, 200); // never faster than 5 Hz
  let processing = false;

  console.log(
    `🧠 Mint worker started with rate limit ~${MINT_FETCH_RPS} tx/s (interval ~${intervalMs.toFixed(
      0
    )} ms)`
  );
  console.log(
    `🧺 Mint queue max size: ${MINT_QUEUE_MAX} (oldest pending tx will be dropped if this is exceeded)\n`
  );

  setInterval(async () => {
    if (processing) return;
    if (queue.length === 0) return;

    const item = queue.shift();
    if (!item) return;

    processing = true;

    try {
      const signature = item.signature;
      const slot = item.slot;
      const ts = item.ts;
      const url = `https://solscan.io/tx/${signature}`;

      let mint: string | null = null;

      try {
        const tx = await connection.getTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        } as any);

        const balances = tx?.meta?.postTokenBalances;
        if (balances && balances.length > 0) {
          mint = balances[0].mint;
        }
      } catch (err: any) {
        const msg =
          typeof err?.message === "string" ? err.message : String(err);
        console.error(
          `⚠️ Mint lookup failed for ${signature.slice(
            0,
            8
          )}...: ${msg.substring(0, 160)}`
        );
      }

      const entry: LaunchLogEntry = { ts, slot, signature, url, mint };
      appendLaunch(entry);

      console.log("🚀 New Pump.fun tx processed (logged):");
      console.log(`  Time: ${ts}`);
      console.log(`  Slot: ${slot}`);
      console.log(`  Sig : ${signature}`);
      if (mint) {
        console.log(`  Mint: ${mint}`);
      } else {
        console.log("  Mint: (unknown / not detected)");
      }
      console.log(`  URL : ${url}`);
      console.log(
        `  Queue size now: ${queue.length} (rate-limited at ~${MINT_FETCH_RPS} tx/s)`
      );
      console.log("-------------------------------------------");
    } finally {
      processing = false;
    }
  }, intervalMs);
}

// ---------------- WATCH MODE ----------------

async function runWatch() {
  console.log("🔭 PumpGuard – WATCH mode");
  console.log(`Using RPC endpoint: ${RPC_ENDPOINT}`);
  console.log(`Log file: ${LOG_FILE}`);
  console.log(
    `Mint lookups are rate-limited to ~${MINT_FETCH_RPS} tx/s to protect your RPC.`
  );
  console.log(`Max queue size: ${MINT_QUEUE_MAX}\n`);

  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // Shared queue of pending transactions to look up
  const pendingQueue: PendingTx[] = [];
  let droppedDueToOverflow = 0;

  startMintWorker(connection, pendingQueue);

  try {
    const subscriptionId = await connection.onLogs(
      PUMPFUN_PROGRAM_ID,
      (log, ctx) => {
        const signature = log.signature;
        const slot = ctx.slot;
        const ts = new Date().toISOString();

        // If queue is at max, drop the oldest pending tx.
        if (pendingQueue.length >= MINT_QUEUE_MAX) {
          pendingQueue.shift();
          droppedDueToOverflow++;
          if (droppedDueToOverflow % 50 === 0) {
            console.warn(
              `⚠️ Queue overflow: dropped ${droppedDueToOverflow} old pending tx so far to keep queue <= ${MINT_QUEUE_MAX}.`
            );
          }
        }

        pendingQueue.push({ ts, slot, signature });

        console.log("🧾 Pump.fun tx detected (queued):");
        console.log(`  Time: ${ts}`);
        console.log(`  Slot: ${slot}`);
        console.log(`  Sig : ${signature}`);
        console.log(
          `  Queue length: ${pendingQueue.length} (max ${MINT_QUEUE_MAX})`
        );
        console.log("-------------------------------------------");
      },
      "confirmed"
    );

    console.log(`Subscribed to logs. Subscription ID: ${subscriptionId}`);
    console.log("Press Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to subscribe to logs:", err);
    process.exit(1);
  }
}

// ---------------- REPORT MODE ----------------

function runReport() {
  console.log("🧾 PumpGuard – REPORT mode");
  console.log(`Reading log file: ${LOG_FILE}\n`);

  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file found yet. Run `npm run watch` first.");
    return;
  }

  const entries = readAllEntries();

  if (entries.length === 0) {
    console.log("Log file is empty. No launches recorded yet.");
    return;
  }

  const total = entries.length;

  // Sort by timestamp to find first/last and compute stats
  const sorted = [...entries].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const firstTime = new Date(first.ts).getTime();
  const lastTime = new Date(last.ts).getTime();

  console.log(`Total launches logged: ${total}`);
  console.log(`First launch: ${first.ts} (slot ${first.slot})`);
  console.log(`Last  launch: ${last.ts} (slot ${last.slot})`);

  if (total >= 2 && lastTime > firstTime) {
    const totalSeconds = (lastTime - firstTime) / 1000;
    const avgSeconds = totalSeconds / (total - 1);

    console.log(
      `Time span between first and last: ~${totalSeconds.toFixed(1)} seconds`
    );
    console.log(
      `Average time between launches: ~${avgSeconds.toFixed(1)} seconds`
    );
  }

  const withMint = entries.filter((e) => e.mint && e.mint.length > 0).length;
  console.log(`Entries with mint detected: ${withMint}/${total}`);
  console.log("");

  // Show only the last N entries
  const N = 10;
  const recent = entries.slice(-N);
  console.log(`Showing last ${recent.length} launches:\n`);

  recent.forEach((e, idx) => {
    const mintPart = e.mint ? ` mint=${e.mint}` : "";
    console.log(`#${idx + 1}`);
    console.log(
      `  Raw: [${e.ts}] slot=${e.slot} sig=${e.signature}${mintPart} url=${e.url}`
    );
    console.log("-------------------------------------------");
  });

  console.log("Report done.");
}

// ---------------- EXPORT CSV MODE ----------------

function runExportCsv() {
  console.log("📤 PumpGuard – EXPORT CSV mode");
  console.log(`Reading log file: ${LOG_FILE}\n`);

  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file found yet. Run `npm run watch` first.");
    return;
  }

  const entries = readAllEntries();

  if (entries.length === 0) {
    console.log("Log file is empty. No launches recorded yet.");
    return;
  }

  const outPath = path.join(__dirname, "..", "pumpguard-report.csv");

  const lines: string[] = [];
  // CSV header (now includes mint)
  lines.push("timestamp,slot,signature,mint,url");

  for (const e of entries) {
    const row = [
      csvEscape(e.ts),
      csvEscape(String(e.slot)),
      csvEscape(e.signature),
      csvEscape(e.mint ?? ""),
      csvEscape(e.url),
    ].join(",");
    lines.push(row);
  }

  const csv = lines.join("\n");
  fs.writeFileSync(outPath, csv, "utf8");

  console.log(`Exported ${entries.length} launches to: ${outPath}`);
  console.log("Open this in Excel, Google Sheets, or with Rainbow CSV.");
}

// ---------------- EXPORT TSV MODE ----------------

function runExportTsv() {
  console.log("📤 PumpGuard – EXPORT TSV mode");
  console.log(`Reading log file: ${LOG_FILE}\n`);

  if (!fs.existsSync(LOG_FILE)) {
    console.log("No log file found yet. Run `npm run watch` first.");
    return;
  }

  const entries = readAllEntries();

  if (entries.length === 0) {
    console.log("Log file is empty. No launches recorded yet.");
    return;
  }

  const outPath = path.join(__dirname, "..", "pumpguard-report.tsv");

  const lines: string[] = [];
  // TSV header (now includes mint)
  lines.push("timestamp\tslot\tsignature\tmint\turl");

  for (const e of entries) {
    const row = [
      tsvEscape(e.ts),
      tsvEscape(String(e.slot)),
      tsvEscape(e.signature),
      tsvEscape(e.mint ?? ""),
      tsvEscape(e.url),
    ].join("\t");
    lines.push(row);
  }

  const tsv = lines.join("\n");
  fs.writeFileSync(outPath, tsv, "utf8");

  console.log(`Exported ${entries.length} launches to: ${outPath}`);
  console.log("Open this in VS Code with Rainbow CSV for perfect columns.");
}

// ---------------- ALIASES (SNIFFER / SCANNER) ----------------

async function runSniffer() {
  await runWatch();
}

async function runScanner() {
  await runWatch();
}

// ---------------- CLI ENTRYPOINT ----------------

function printHelp() {
  console.log("PumpGuard CLI");
  console.log("");
  console.log("Usage:");
  console.log(
    "  npm run watch       # Watch new Pump.fun launches (logs mint when possible, rate-limited with bounded queue)"
  );
  console.log("  npm run report      # Show launches + stats from log file");
  console.log("  npm run export      # Export all launches to pumpguard-report.csv");
  console.log("  npm run export-tsv  # Export all launches to pumpguard-report.tsv");
  console.log("  npm run sniffer     # Alias for watch");
  console.log("  npm run scanner     # Alias for watch");
  console.log("");
}

const cmd = process.argv[2];

(async () => {
  switch (cmd) {
    case "watch":
      await runWatch();
      break;
    case "report":
      runReport();
      break;
    case "export":
      runExportCsv();
      break;
    case "export-tsv":
      runExportTsv();
      break;
    case "sniffer":
      await runSniffer();
      break;
    case "scanner":
      await runScanner();
      break;
    default:
      printHelp();
      break;
  }
})();
