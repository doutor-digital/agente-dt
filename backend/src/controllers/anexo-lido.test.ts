import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getImageUrl } from './webhook.controller.js';
import { parteDoAnexo } from '../services/vision.service.js';
import { ehTranscricaoDeComprovante } from '../lib/pagamento-antecipado.js';

// Bebedouro, 22/10/2026: a Marinês mandou o comprovante do Pix em PDF sete vezes. O webhook descartava
// o "arquivo" na entrada e a IA, sem saber que ele tinha chegado, pedia o comprovante de novo.

const msg = (attachment: { type?: string; link?: string; file_name?: string }) => ({ type: 'incoming', attachment });

test('PDF que chega como arquivo é lido', () => {
  assert.equal(
    getImageUrl(msg({ type: 'file', link: 'https://drive.kommo.com/d/1', file_name: 'Comprovante Pix.pdf' })),
    'https://drive.kommo.com/d/1',
  );
});

test('arquivo sem nome também é lido (a visão decide pelo conteúdo)', () => {
  assert.equal(getImageUrl(msg({ type: 'file', link: 'https://drive.kommo.com/d/2' })), 'https://drive.kommo.com/d/2');
});

test('áudio ou vídeo mandado como arquivo não vai pra visão', () => {
  assert.equal(getImageUrl(msg({ type: 'file', link: 'https://x/d/3', file_name: 'audio.ogg' })), null);
  assert.equal(getImageUrl(msg({ type: 'file', link: 'https://x/d/4', file_name: 'video.mp4' })), null);
});

test('foto tem preferência sobre arquivo na mesma mensagem', () => {
  assert.equal(
    getImageUrl({
      type: 'incoming',
      attachments: [
        { type: 'file', link: 'https://x/pdf', file_name: 'a.pdf' },
        { type: 'picture', link: 'https://x/foto' },
      ],
    }),
    'https://x/foto',
  );
});

test('PDF vai como arquivo pro modelo; foto vai como imagem', () => {
  const pdf = parteDoAnexo(Buffer.from('%PDF-1.4\n1 0 obj'));
  assert.equal(pdf.tipo, 'arquivo');
  assert.equal(pdf.parte.type, 'file');
  assert.match(pdf.parte.type === 'file' ? pdf.parte.file.file_data : '', /^data:application\/pdf;base64,/);

  const png = parteDoAnexo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  assert.equal(png.tipo, 'imagem');
  assert.match(png.parte.type === 'image_url' ? png.parte.image_url.url : '', /^data:image\/png;base64,/);
});

test('comprovante lido de PDF conta como prova de pagamento', () => {
  assert.equal(ehTranscricaoDeComprovante('[arquivo do cliente]: COMPROVANTE: R$ 200,00, 21/10/2026 15:40, pagador Marinês'), true);
  assert.equal(ehTranscricaoDeComprovante('[arquivo do cliente]: laudo de ressonância da coluna lombar'), false);
});
