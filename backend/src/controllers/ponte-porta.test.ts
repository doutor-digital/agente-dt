import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { chaveDoWidget } from '../lib/widget-agenda.js';
import { unidadeDaPonte } from './widget-franquia.controller.js';

// A unidade "do banco" sem banco: a porta só precisa do findUnique.
Object.defineProperty(prisma, 'unit', {
  value: { findUnique: async ({ where }: { where: { slug: string } }) => ({ id: 'u1', slug: where.slug, isActive: true }) },
  configurable: true,
});

function pedido(slug: string, chave: string | null, ip = '10.0.0.1', query: Record<string, string> = {}) {
  return { params: { slug }, ip, query, header: (n: string) => (n.toLowerCase() === 'x-widget-key' ? (chave ?? undefined) : undefined) } as unknown as Request;
}

function resposta() {
  const r = { codigo: 200, corpo: null as unknown, status(c: number) { r.codigo = c; return r; }, json(b: unknown) { r.corpo = b; return r; } };
  return r;
}

describe('a porta das rotas da Ponte (chave ANTES do limitador)', () => {
  it('sem a chave certa: 403 sempre, e não gasta o limite da unidade', async () => {
    const slug = 'unidade-porta-a';
    const limite = { balde: 'teste-porta', max: 3 };
    for (let i = 0; i < 40; i++) {
      const res = resposta();
      assert.equal(await unidadeDaPonte(pedido(slug, 'chave-errada'), res as unknown as Response, limite), null);
      assert.equal(res.codigo, 403, `pedido ${i + 1} sem chave`);
    }
    // quem tem a chave continua entrando (o limite não foi gasto pelos 40 de cima)
    const certa = chaveDoWidget(slug, env.SESSION_JWT_SECRET);
    for (let i = 0; i < 3; i++) {
      const res = resposta();
      const unit = await unidadeDaPonte(pedido(slug, certa), res as unknown as Response, limite);
      assert.equal(unit?.slug, slug, `pedido ${i + 1} com chave`);
    }
    const quarto = resposta();
    assert.equal(await unidadeDaPonte(pedido(slug, certa), quarto as unknown as Response, limite), null);
    assert.equal(quarto.codigo, 429, 'o limite continua valendo para quem tem a chave');
  });

  it('a chave só vale no header (na URL ela iria para o log de acesso)', async () => {
    const slug = 'unidade-porta-b';
    const res = resposta();
    const unit = await unidadeDaPonte(pedido(slug, null, '10.0.0.2', { chave: chaveDoWidget(slug, env.SESSION_JWT_SECRET) }), res as unknown as Response, { balde: 'b', max: 5 });
    assert.equal(unit, null);
    assert.equal(res.codigo, 403);
  });

  it('a chave de outra unidade não abre esta', async () => {
    const res = resposta();
    assert.equal(await unidadeDaPonte(pedido('unidade-porta-c', chaveDoWidget('outra', env.SESSION_JWT_SECRET)), res as unknown as Response, { balde: 'c', max: 5 }), null);
    assert.equal(res.codigo, 403);
  });
});
