// src/risk-report.ts
import fs from "fs";
import readline from "readline";
import path from "path";
import chalk from "chalk";
import { buildConnectionFromEnv, assessMintRisk, RiskAssessment } from "./risk";

interface LaunchEntry {
  time: string;
  slot: number;
  sig: string;
  mint: string;
  url: string;
}

const LOG_FILE = path.resolve(process.cwd(), "pumpguard-launches.log");
const OUTPUT_TSV = path.resolve(process.cwd(), "pumpguard-risk-report.tsv");

async function parseLogFile(): Promise<LaunchEntry[]> {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(
      chalk.red(`\n❌ Log file not found: ${LOG_FILE}\nRun "npm run watch" first.`)
    );
    process.exit(1);
  }

  const fileStream = fs.createReadStream(LOG_FILE, "utf8");
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const entries: LaunchEntry[] = [];
  const rawPattern =
    /\[(?<time>.+?)\].*slot=(?<slot>\d+).*sig=(?<sig>\S+).*mint=(?<mint>\S+).*url=(?<url>\S+)/;

  for await (const line of rl) {
    const match = rawPattern.exec(line);
    if (!match || !match.groups) continue;

    entries.push({
      time: match.groups.time,
      slot: Number(match.groups.slot),
      sig: match.groups.sig,
      mint: match.groups.mint,
      url: match.groups.url,
    });
  }

  return entries;
}

async function main() {
  console.log(chalk.cyan.bold("\n🧾 PumpGuard – RISK REPORT mode\n"));
  console.log(chalk.gray(`Reading log file: ${LOG_FILE}\n`));

  const launches = await parseLogFile();

  if (launches.length === 0) {
    console.log(
      chalk.yellow(
        "No launch entries found in log. Make sure watch mode has run and detected pump.fun mints."
      )
    );
    return;
  }

  console.log(
    chalk.green(
      `Found ${launches.length} logged launches. Building mint risk profile...\n`
    )
  );

  const connection = buildConnectionFromEnv();
  if (!connection) {
    console.log(
      chalk.yellow(
        "RPC_ENDPOINT is not set – risk analysis will be based only on basic heuristics.\n"
      )
    );
  }

  // Unique mints
  const uniqueMints = Array.from(new Set(launches.map((l) => l.mint)));
  console.log(
    chalk.gray(
      `Unique mints: ${uniqueMints.length} (each will be scored once, then reused)\n`
    )
  );

  const mintRiskMap = new Map<string, RiskAssessment>();

  let processed = 0;
  for (const mint of uniqueMints) {
    processed++;
    if (processed % 10 === 0) {
      process.stdout.write(
        chalk.gray(`Scoring mints: ${processed}/${uniqueMints.length}\r`)
      );
    }

    const risk = await assessMintRisk({ mint }, connection);
    mintRiskMap.set(mint, risk);
  }
  process.stdout.write("\n");

  // Attach risk to each launch
  const enriched = launches.map((l) => {
    const risk = mintRiskMap.get(l.mint)!;
    return { ...l, risk };
  });

  // Write TSV
  const header = [
    "time",
    "slot",
    "sig",
    "mint",
    "risk_score",
    "risk_level",
    "risk_tags",
    "url",
  ].join("\t");

  const rows = enriched.map((e) =>
    [
      e.time,
      e.slot,
      e.sig,
      e.mint,
      e.risk.score,
      e.risk.level,
      e.risk.tags.join(","),
      e.url,
    ].join("\t")
  );

  const tsvContent = [header, ...rows].join("\n");
  fs.writeFileSync(OUTPUT_TSV, tsvContent, "utf8");

  console.log(chalk.green(`\n✅ Wrote risk report: ${OUTPUT_TSV}\n`));

  // Quick console summary
  const high = enriched.filter((e) => e.risk.level === "HIGH").length;
  const medium = enriched.filter((e) => e.risk.level === "MEDIUM").length;
  const low = enriched.filter((e) => e.risk.level === "LOW").length;
  const unknown = enriched.filter((e) => e.risk.level === "UNKNOWN").length;

  console.log(chalk.bold("Summary by risk level:"));
  console.log(chalk.red(`  HIGH   : ${high}`));
  console.log(chalk.yellow(`  MEDIUM : ${medium}`));
  console.log(chalk.green(`  LOW    : ${low}`));
  console.log(chalk.gray(`  UNKNOWN: ${unknown}\n`));

  console.log(
    chalk.gray(
      "Open the TSV in Excel / Google Sheets for filtering by score, tags, time, etc.\n"
    )
  );
}

main().catch((err) => {
  console.error(chalk.red("\n❌ risk-report crashed:\n"), err);
  process.exit(1);
});
