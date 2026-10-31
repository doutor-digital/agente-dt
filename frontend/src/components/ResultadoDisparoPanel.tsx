import { useEffect, useState } from 'react';
import { Megaphone, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { usePolling } from '../hooks/usePolling';
import { ResultadoDisparoView, type CarregamentoDePessoas } from './disparo/ResultadoDisparoView';
import type { DisparoOndaResumo } from '../types/disparo';

/**
 * Resultado de um disparo de campanha para o gestor: funil, custo, envios por hora e freios.
 * Onda escolhida por ?onda=<id>; sem isso, a que está andando (ou a mais recente).
 */
export function ResultadoDisparoPanel() {
  const [ondas, setOndas] = useState<DisparoOndaResumo[] | null>(null);
  const [erroLista, setErroLista] = useState<string | null>(null);
  const [ondaId, setOndaId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('onda'));

  useEffect(() => {
    let vivo = true;
    api
      .listDisparoOndas()
      .then((lista) => {
        if (!vivo) return;
        setOndas(lista);
        setOndaId((atual) => {
          if (atual) return atual;
          const andando = lista.find((o) => o.estado === 'aprovada' || o.estado === 'pausada');
          return (andando ?? lista[0])?.id ?? null;
        });
      })
      .catch((e: unknown) => vivo && setErroLista(mensagemDeErro(e)));
    return () => {
      vivo = false;
    };
  }, []);

  const resultado = usePolling(() => (ondaId ? api.getDisparoResultado(ondaId) : Promise.resolve(null)), 60_000, [ondaId]);
  // A lista de pessoas é uma segunda chamada: se falhar, o resto da tela continua de pé.
  const pessoas = usePolling(() => (ondaId ? api.getDisparoPessoas(ondaId) : Promise.resolve(null)), 60_000, [ondaId]);

  if (erroLista) {
    return <Aviso titulo="Não consegui listar os disparos" texto={erroLista} acao="Tentar de novo" onAcao={() => window.location.reload()} />;
  }
  if (ondas && ondas.length === 0 && !ondaId) {
    return (
      <Aviso
        titulo="Nenhum disparo ainda"
        texto="Quando uma campanha for montada e liberada, o resultado aparece aqui, com funil, custo e envios por hora."
      />
    );
  }
  if (resultado.error && !resultado.data) {
    const e = resultado.error as { response?: { status?: number } };
    return (
      <Aviso
        titulo="Não consegui carregar o resultado deste disparo"
        texto={
          e.response?.status === 404
            ? 'O servidor não tem este resultado: a onda não existe ou a tela de resultado ainda não foi publicada. Nada foi alterado no envio.'
            : mensagemDeErro(resultado.error)
        }
        acao="Tentar de novo"
        onAcao={resultado.refresh}
      />
    );
  }
  if (!resultado.data) return <Carregando />;

  const listaPessoas: CarregamentoDePessoas = pessoas.data
    ? { estado: 'ok', itens: pessoas.data }
    : pessoas.error
      ? { estado: 'erro', tentarDeNovo: pessoas.refresh }
      : { estado: 'carregando' };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {ondas && ondas.length > 1 && (
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 sm:px-6">
          <label htmlFor="seletor-onda" className="text-sm text-zinc-300">
            Disparo
          </label>
          <select id="seletor-onda" className="field min-h-11 max-w-md" value={ondaId ?? ''} onChange={(e) => setOndaId(e.target.value)}>
            {ondas.map((o) => (
              <option key={o.id} value={o.id}>
                {o.campanha} · {o.unidade} · {o.estado}
              </option>
            ))}
          </select>
        </div>
      )}
      <ResultadoDisparoView dados={resultado.data} pessoas={listaPessoas} onAtualizar={() => { resultado.refresh(); pessoas.refresh(); }} atualizando={resultado.loading} />
    </div>
  );
}

function mensagemDeErro(e: unknown): string {
  const x = e as { response?: { data?: { message?: string; erro?: string; error?: string } }; message?: string };
  return x?.response?.data?.erro ?? x?.response?.data?.message ?? x?.response?.data?.error ?? x?.message ?? 'Erro desconhecido.';
}

function Carregando() {
  return (
    <div className="flex-1 space-y-4 p-6" aria-busy="true" aria-label="Carregando o resultado">
      <div className="h-7 w-64 animate-pulse rounded-lg bg-zinc-900" />
      <div className="h-20 animate-pulse rounded-xl bg-zinc-900" />
      <div className="h-80 animate-pulse rounded-xl bg-zinc-900" />
    </div>
  );
}

function Aviso({ titulo, texto, acao, onAcao }: { titulo: string; texto: string; acao?: string; onAcao?: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="max-w-md text-center">
        <Megaphone size={32} className="mx-auto text-zinc-500" aria-hidden />
        <h2 className="mt-3 text-base font-semibold text-zinc-100">{titulo}</h2>
        <p className="mt-1 text-sm text-zinc-400">{texto}</p>
        {acao && onAcao && (
          <button type="button" onClick={onAcao} className="btn-ghost mt-4 min-h-11">
            <RefreshCw size={14} aria-hidden /> {acao}
          </button>
        )}
      </div>
    </div>
  );
}
