/**
 * Sobe a foto da fachada de uma unidade no Drive do Kommo (uma vez) e grava os ids
 * na unidade — é o que o cartão de chegada reenvia depois de cada agendamento.
 * Opcionalmente grava o link do mapa.
 *
 *   tsx src/scripts/subir-fachada.ts <slug> <arquivo.jpg|png> [url-do-mapa]
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { prisma } from '../lib/prisma.js';
import { createKommoClient } from '../services/kommo.service.js';

const [slug, caminho, mapa] = process.argv.slice(2);
if (!slug || !caminho) {
  console.error('uso: tsx src/scripts/subir-fachada.ts <slug> <arquivo.jpg|png> [url-do-mapa]');
  process.exit(1);
}
const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const mime = MIME[extname(caminho).toLowerCase()];
if (!mime) {
  console.error('formato não aceito pelo chat do Kommo (use jpg, png ou webp)');
  process.exit(1);
}

const unit = await prisma.unit.findUnique({ where: { slug } });
if (!unit) {
  console.error(`unidade ${slug} não existe`);
  process.exit(1);
}
const bytes = await readFile(caminho);
const arquivo = await createKommoClient(unit).uploadToDriveDetalhado(bytes, `fachada-${slug}${extname(caminho).toLowerCase()}`, mime);
if (!arquivo.versionUuid) throw new Error('Drive não devolveu version_uuid');
await prisma.unit.update({
  where: { id: unit.id },
  data: {
    clinicPhotoDriveUuid: arquivo.uuid,
    clinicPhotoDriveVersion: arquivo.versionUuid,
    ...(mapa ? { clinicMapUrl: mapa } : {}),
  },
});
console.log(`ok: ${slug} · ${basename(caminho)} (${Math.round(bytes.length / 1024)} KB) · drive ${arquivo.uuid}${mapa ? ' · mapa gravado' : ''}`);
await prisma.$disconnect();
