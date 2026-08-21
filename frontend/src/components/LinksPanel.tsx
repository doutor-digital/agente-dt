import { useEffect, useState, useCallback } from 'react';
import { Link2, Plus, Trash2, Loader2, RefreshCw, Youtube, Star, FlaskConical, Globe } from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { api } from '../lib/api';
import type { KnowledgeLinkEntry } from '../types/api';

const TIPO: Record<string, { label: string; icon: typeof Globe; cls: string }> = {
  video: { label: 'Vídeo', icon: Youtube, cls: 'text-rose-300 bg-rose-500/10 ring-rose-500/30' },
  avaliacao: { label: 'Avaliações', icon: Star, cls: 'text-amber-300 bg-amber-500/10 ring-amber-500/30' },
  artigo: { label: 'Artigo científico', icon: FlaskConical, cls: 'text-sky-300 bg-sky-500/10 ring-sky-500/30' },
  pagina: { label: 'Página', icon: Globe, cls: 'text-zinc-300 bg-zinc-500/10 ring-zinc-500/30' },
};

export function LinksPanel() {
  const { selectedUnitId } = useUnit();
  const [links, setLinks] = useState<KnowledgeLinkEntry[] | null>(null);
  const [url, setUrl] = useState('');
  const [adicionando, setAdicionando] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedUnitId) {
      setLinks([]);
      return;
    }
    try {
      setLinks(await api.listKnowledgeLinks(selectedUnitId));
    } catch {
      setLinks([]);
    }
  }, [selectedUnitId]);

  useEffect(() => {
    setLinks(null);
    void load();
  }, [load]);

  async function adicionar() {
    const u = url.trim();
    if (!u || !selectedUnitId || adicionando) return;
    setAdicionando(true);
    setMsg(null);
    try {
      const link = await api.addKnowledgeLink(selectedUnitId, u);
      setUrl('');
      await load();
      if (link?.status === 'processado') {
        setMsg(`✅ Lido! ${link.entriesCriadas} pergunta${link.entriesCriadas === 1 ? '' : 's'} e resposta${link.entriesCriadas === 1 ? '' : 's'} entraram na base de conhecimento.`);
      } else if (link?.status === 'falhou') {
        setMsg('⚠️ Não consegui aproveitar esse link — veja o motivo na lista abaixo.');
      }
    } catch {
      setMsg('Não consegui processar agora. Confira o link e tente de novo.');
    } finally {
      setAdicionando(false);
    }
  }

  async function reprocessar(l: KnowledgeLinkEntry) {
    if (!selectedUnitId) return;
    setBusy(l.id);
    try {
      await api.reprocessKnowledgeLink(selectedUnitId, l.id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remover(l: KnowledgeLinkEntry) {
    if (!selectedUnitId) return;
    setBusy(l.id);
    try {
      await api.deleteKnowledgeLink(selectedUnitId, l.id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!selectedUnitId) {
    return <div className="p-8 text-sm text-zinc-500">Selecione um agente pra gerenciar os links.</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center gap-2.5 mb-1.5">
          <Link2 size={18} className="text-brand-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Links de conhecimento</h1>
        </div>
        <p className="text-[13px] text-zinc-500 mb-6">
          Cole um link — depoimento no YouTube, artigo científico, página com avaliações — e a IA{' '}
          <span className="text-zinc-300">lê o conteúdo e transforma em perguntas e respostas</span>{' '}
          na base de conhecimento desta clínica. As entradas geradas aparecem na aba Treinar.
        </p>

        <div className="surface p-4 mb-4">
          <div className="flex gap-2 items-start">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && adicionar()}
              placeholder="https://www.youtube.com/watch?v=…  ·  https://www.scielo.br/…"
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-[14px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-brand-500"
            />
            <button
              onClick={adicionar}
              disabled={!url.trim() || adicionando}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {adicionando ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              {adicionando ? 'Lendo o link…' : 'Adicionar'}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">
            A leitura leva alguns segundos. Páginas que só carregam por aplicativo (ex.: avaliações do
            Google Maps) podem não entregar o texto — nesse caso, cole o conteúdo direto na aba Treinar.
          </p>
          {msg && <p className="text-[12px] text-zinc-300 mt-2">{msg}</p>}
        </div>

        {links === null && (
          <div className="flex justify-center py-10"><Loader2 className="animate-spin text-zinc-500" size={18} /></div>
        )}
        {links && links.length === 0 && (
          <div className="surface p-10 text-center text-sm text-zinc-500">
            Nenhum link ainda. Cole o primeiro acima — depoimentos e artigos deixam a IA mais convincente e embasada.
          </div>
        )}
        {links && links.length > 0 && (
          <ul className="grid gap-2.5">
            {links.map((l) => {
              const t = TIPO[l.tipo] ?? TIPO.pagina;
              const Icon = t.icon;
              return (
                <li key={l.id} className="surface px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={clsx('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1', t.cls)}>
                      <Icon size={11} /> {t.label}
                    </span>
                    <span
                      className={clsx(
                        'text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ring-1',
                        l.status === 'processado'
                          ? 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30'
                          : l.status === 'falhou'
                            ? 'text-rose-300 bg-rose-500/10 ring-rose-500/30'
                            : 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/30',
                      )}
                    >
                      {l.status === 'processado' ? `${l.entriesCriadas} na base` : l.status}
                    </span>
                    <span className="flex-1" />
                    {l.status === 'falhou' && (
                      <button
                        onClick={() => void reprocessar(l)}
                        disabled={busy === l.id}
                        title="Tentar ler de novo"
                        className="text-zinc-500 hover:text-zinc-200 p-1"
                      >
                        {busy === l.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                      </button>
                    )}
                    <button
                      onClick={() => void remover(l)}
                      disabled={busy === l.id}
                      title="Remover o link (as entradas já criadas ficam na base)"
                      className="text-zinc-600 hover:text-rose-400 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="text-[13.5px] text-zinc-100 mt-1.5 leading-snug">
                    {l.titulo || l.url}
                  </div>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-zinc-500 hover:text-brand-300 break-all"
                  >
                    {l.url}
                  </a>
                  {l.erro && <div className="text-[12px] text-rose-300/90 mt-1.5">{l.erro}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
