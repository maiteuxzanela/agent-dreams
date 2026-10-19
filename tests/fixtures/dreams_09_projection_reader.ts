/**
 * TICKET-DREAMS-09 — Fixture determinística do READER concorrente de projeções.
 *
 * Processo REAL separado (não é mock): lê `PROJ_FILE` em loop apertado por
 * `PROJ_DURATION_MS` e valida que CADA leitura observada é uma versão COMPLETA
 * e íntegra da projeção — o conteúdo deve casar byte-a-byte com um dos dois
 * estados válidos (A ou B), identificados por SHA-256.
 *
 * Se o escritor NÃO for atômico (truncate in-place / write parcial), o reader
 * observa `size 0` ou conteúdo "rasgado" (torn) e o contador é incrementado —
 * o que falha a suíte do engenheiro de testes. Com `write-temp + rename(2)`, nenhuma dessas
 * condições é observável: ou o reader vê A inteiro, ou B inteiro.
 *
 * Saída (stdout): `PROJ_READER_RESULT:{...}` — JSON de uma linha.
 */
import fs from "fs";

const file = process.env.PROJ_FILE;
const durationMs = Number(process.env.PROJ_DURATION_MS ?? "2000");
const hashA = process.env.PROJ_HASH_A ?? "";
const hashB = process.env.PROJ_HASH_B ?? "";

if (!file || !hashA || !hashB) {
  console.error("missing PROJ_FILE/PROJ_HASH_A/PROJ_HASH_B");
  process.exit(2);
}

const sha256 = (buf: Buffer): string =>
  new Bun.CryptoHasher("sha256").update(buf).digest("hex");

let reads = 0;
let empty = 0;
let torn = 0;
const samples: string[] = [];

const deadline = Date.now() + durationMs;
while (Date.now() < deadline) {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    // Destino momentaneamente ausente entre unlink/rename nunca deveria ocorrer
    // no padrão atômico (rename substitui o nome de forma indivisível); se
    // ocorrer num cenário não-atômico, conta como leitura rasgada.
    reads++;
    torn++;
    if (samples.length < 3) samples.push("<ENOENT>");
    continue;
  }

  reads++;
  if (buf.length === 0) {
    empty++;
    if (samples.length < 3) samples.push("<EMPTY>");
    continue;
  }

  const h = sha256(buf);
  if (h !== hashA && h !== hashB) {
    torn++;
    if (samples.length < 3) samples.push(buf.toString("utf8").slice(0, 160));
  }
}

console.log(
  "PROJ_READER_RESULT:" + JSON.stringify({ reads, empty, torn, samples })
);
