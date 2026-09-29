/**
 * O semáforo do sincronizador da franquia, testado à parte.
 *
 * Ele nasceu em 29/09/2026 junto com o relógio por unidade: como cada unidade passou a varrer no
 * próprio horário, várias podem cair ao mesmo tempo, e o teto existe para não bater na franquia com
 * vinte requisições paralelas.
 *
 * A primeira versão devolvia a vaga (`rodando--`) e só depois acordava a fila. Achei que isso
 * abrisse uma fresta para um chamador novo furar o teto e troquei pela entrega direta do slot —
 * mas, medindo, NÃO consegui reproduzir o furo, nem forçando um chamador a cair em microtask no
 * instante da troca: as duas linhas vivem no mesmo bloco síncrono e nada se intercala ali. A forma
 * atual continua sendo a correta e não custa nada; o furo, porém, era teórico. Fica registrado para
 * ninguém "consertar de novo" achando que achou algo.
 *
 * A implementação real vive dentro de `franquia-sync-worker.ts` (módulo que abre conexão com banco e
 * Kommo no import). A cópia abaixo é a MESMA lógica, e é o que este arquivo cobre — se uma mudar, a
 * outra precisa mudar junto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function criarSemaforo(teto: number) {
  let rodando = 0;
  let pico = 0;
  const fila: Array<() => void> = [];
  return {
    get pico() {
      return pico;
    },
    async comVaga<T>(fn: () => Promise<T>): Promise<T> {
      if (rodando >= teto) await new Promise<void>((libera) => fila.push(libera));
      else rodando++;
      pico = Math.max(pico, rodando);
      try {
        return await fn();
      } finally {
        const proximo = fila.shift();
        if (proximo) proximo();
        else rodando--;
      }
    },
  };
}

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('semáforo: nunca passa do teto, mesmo com chamador novo chegando no meio', async () => {
  const s = criarSemaforo(2);
  let simultaneos = 0;
  let picoReal = 0;

  const tarefa = async () => {
    simultaneos++;
    picoReal = Math.max(picoReal, simultaneos);
    await espera(15);
    simultaneos--;
  };

  // Seis de uma vez com teto 2, e mais um chegando depois que a primeira leva já rodou.
  const lote = Array.from({ length: 6 }, () => s.comVaga(tarefa));
  await espera(16);
  lote.push(s.comVaga(tarefa));
  await Promise.all(lote);

  assert.equal(picoReal <= 2, true, `rodaram ${picoReal} ao mesmo tempo com teto 2`);
  assert.equal(simultaneos, 0, 'toda vaga foi devolvida');
});

test('semáforo: exceção na tarefa devolve a vaga em vez de travar a fila', async () => {
  const s = criarSemaforo(1);
  await assert.rejects(s.comVaga(async () => { throw new Error('estourou'); }), /estourou/);
  // Se a vaga não voltasse, esta chamada ficaria pendurada para sempre e o teste daria timeout.
  assert.equal(await s.comVaga(async () => 'passou'), 'passou');
});

test('semáforo: a ordem de atendimento é a da chegada', async () => {
  const s = criarSemaforo(1);
  const ordem: number[] = [];
  await Promise.all(
    [1, 2, 3, 4].map((n) =>
      s.comVaga(async () => {
        ordem.push(n);
        await espera(5);
      }),
    ),
  );
  assert.deepEqual(ordem, [1, 2, 3, 4], 'quem chegou primeiro entrou primeiro');
});
