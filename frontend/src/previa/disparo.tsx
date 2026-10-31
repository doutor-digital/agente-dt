/**
 * Prévia da tela de resultado do disparo com DADOS DE MENTIRA, sem login e sem backend.
 * Só existe em desenvolvimento (main.tsx faz import dinâmico dentro de `import.meta.env.DEV`),
 * então nunca vai para o pacote de produção.
 *
 *   /__previa/disparo?v=vazio|cheio|pausada   (&pessoas=erro|carregando para os outros estados da lista)
 */
import { ResultadoDisparoView, type CarregamentoDePessoas } from '../components/disparo/ResultadoDisparoView';
import { AGORA_DA_PREVIA, MOCK_CHEIO, MOCK_PAUSADA, MOCK_VAZIO, pessoasDaPrevia } from '../components/disparo/mocks';

export function PreviaDisparo() {
  const q = new URLSearchParams(window.location.search);
  const v = q.get('v');
  const dados = v === 'cheio' ? MOCK_CHEIO : v === 'pausada' ? MOCK_PAUSADA : MOCK_VAZIO;
  const p = q.get('pessoas');
  const pessoas: CarregamentoDePessoas =
    p === 'erro' ? { estado: 'erro', tentarDeNovo: () => undefined } : p === 'carregando' ? { estado: 'carregando' } : { estado: 'ok', itens: pessoasDaPrevia(dados) };
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100">
      <ResultadoDisparoView dados={dados} pessoas={pessoas} agora={AGORA_DA_PREVIA} onAtualizar={() => undefined} />
    </div>
  );
}
