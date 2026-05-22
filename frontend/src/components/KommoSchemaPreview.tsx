// ============================================================================
// KommoSchemaPreview — visualizador read-only de etapas e tags da unidade.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Puxa GET /units/:id/kommo-pipelines e /kommo-tags ao montar (ou via botão
// Recarregar). É read-only — serve pra você SABER quais IDs/nomes existem no
// Kommo da unidade, e usar essa info ao instruir a IA:
//   - "mover_etapa(<id>)" — copia o ID daqui
//   - "aplicar_tag('<nome>')" — copia o nome daqui
//
// Falha (token inválido, sub errado) vira um aviso inline pra ajustar a
// credencial — não bloqueia o resto do form.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Loader2, RefreshCw, Tag, Workflow } from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from '../context/ToastContext';
import type { KommoPipelinesResponse, KommoTagsResponse } from '../types/api';

interface Props {
  unitId: string;
  /** Se o token ainda não foi salvo, não vale a pena tentar. */
  canFetch: boolean;
}

export function KommoSchemaPreview({ unitId, canFetch }: Props) {
  const toast = useToast();
  const [pipelines, setPipelines] = useState<KommoPipelinesResponse | null>(null);
  const [tags, setTags] = useState<KommoTagsResponse | null>(null);
  const [loadingPipelines, setLoadingPipelines] = useState(false);
  const [loadingTags, setLoadingTags] = useState(false);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);

  const loadPipelines = useCallback(async () => {
    if (!canFetch) return;
    setLoadingPipelines(true);
    setPipelinesError(null);
    try {
      const data = await api.kommoPipelines(unitId);
      setPipelines(data);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string } } };
      setPipelinesError(
        e?.response?.data?.message ?? e?.response?.data?.error ?? 'Falha ao acessar Kommo',
      );
    } finally {
      setLoadingPipelines(false);
    }
  }, [unitId, canFetch]);

  const loadTags = useCallback(async () => {
    if (!canFetch) return;
    setLoadingTags(true);
    setTagsError(null);
    try {
      const data = await api.kommoTags(unitId);
      setTags(data);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string; message?: string } } };
      setTagsError(
        e?.response?.data?.message ?? e?.response?.data?.error ?? 'Falha ao acessar Kommo',
      );
    } finally {
      setLoadingTags(false);
    }
  }, [unitId, canFetch]);

  useEffect(() => {
    if (canFetch) {
      void loadPipelines();
      void loadTags();
    }
  }, [canFetch, loadPipelines, loadTags]);

  function copy(text: string, what: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${what} copiado`))
      .catch(() => toast.error('falha ao copiar'));
  }

  if (!canFetch) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-200/80 leading-relaxed">
        Preencha <strong>Subdomínio</strong> e <strong>Access Token</strong> do Kommo acima
        e salve a unidade — depois esta seção carrega etapas e tags direto da sua conta.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Etapas */}
      <SubBlock
        icon={<Workflow size={14} className="text-sky-400" />}
        title="Etapas do Kommo"
        subtitle="Cada linha mostra: Funil → Etapa (ID). Use os IDs para configurar movimentação automática na aba 'Configurar IA'."
        loading={loadingPipelines}
        onReload={() => void loadPipelines()}
      >
        {pipelinesError && (
          <ErrorBox label="Não consegui carregar as etapas do Kommo">
            {pipelinesError}
          </ErrorBox>
        )}

        {!pipelinesError && pipelines && (
          <div className="space-y-3">
            {(pipelines.pipelines ?? [])
              .filter((p) => !p.isArchive)
              .map((p) => (
                <div key={p.id} className="rounded-md border border-zinc-800 bg-zinc-950/60">
                  <div className="px-3 py-1.5 border-b border-zinc-800/60 text-[11px] uppercase tracking-wider text-zinc-400 flex items-center gap-2">
                    <span className="text-zinc-300 font-semibold">{p.name}</span>
                    {p.isMain && (
                      <span className="text-[9px] px-1 py-0.5 rounded bg-brand-500/15 text-brand-300">
                        principal
                      </span>
                    )}
                    <span className="ml-auto text-[10px] text-zinc-600 font-mono">
                      pipeline #{p.id}
                    </span>
                  </div>
                  <ul className="divide-y divide-zinc-800/40">
                    {p.statuses.map((s) => (
                      <li
                        key={s.id}
                        className="px-3 py-1.5 flex items-center gap-2 text-xs"
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: s.color ?? '#52525b' }}
                        />
                        <span className="text-zinc-200 truncate">{s.name}</span>
                        <span className="ml-auto text-[10px] text-zinc-500 font-mono">
                          {s.id}
                        </span>
                        <button
                          type="button"
                          onClick={() => copy(String(s.id), `ID da etapa "${s.name}"`)}
                          className="text-zinc-500 hover:text-zinc-200 p-1"
                          title="Copiar ID"
                        >
                          <Copy size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            {(pipelines.pipelines ?? []).filter((p) => !p.isArchive).length === 0 && (
              <div className="text-[11px] text-zinc-500">Nenhum pipeline ativo.</div>
            )}
          </div>
        )}
      </SubBlock>

      {/* Tags */}
      <SubBlock
        icon={<Tag size={14} className="text-amber-400" />}
        title="Tags do Kommo"
        subtitle={'Use os nomes ao instruir a IA: \'aplicar_tag("Quente")\'. A tool é idempotente.'}
        loading={loadingTags}
        onReload={() => void loadTags()}
      >
        {tagsError && (
          <ErrorBox label="Não consegui carregar as tags do Kommo">
            {tagsError}
          </ErrorBox>
        )}

        {!tagsError && tags && (
          <div className="rounded-md border border-zinc-800 bg-zinc-950/60">
            {(tags.tags ?? []).length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-500">
                Nenhuma tag criada nesta conta Kommo ainda.
              </div>
            ) : (
              <ul className="divide-y divide-zinc-800/40">
                {(tags.tags ?? []).map((t) => (
                  <li key={t.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: t.color ?? '#52525b' }}
                    />
                    <span className="text-zinc-200 truncate">{t.name}</span>
                    <span className="ml-auto text-[10px] text-zinc-500 font-mono">{t.id}</span>
                    <button
                      type="button"
                      onClick={() => copy(t.name, `Nome da tag "${t.name}"`)}
                      className="text-zinc-500 hover:text-zinc-200 p-1"
                      title="Copiar nome"
                    >
                      <Copy size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SubBlock>
    </div>
  );
}

function SubBlock({
  icon,
  title,
  subtitle,
  loading,
  onReload,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  loading: boolean;
  onReload: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className="text-xs font-semibold text-zinc-100">{title}</h4>
        {loading && <Loader2 className="animate-spin text-zinc-500" size={12} />}
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="ml-auto text-[11px] text-zinc-400 hover:text-zinc-100 inline-flex items-center gap-1 disabled:opacity-40"
          title="Recarregar"
        >
          <RefreshCw size={11} />
          Recarregar
        </button>
      </div>
      {subtitle && <p className="text-[11px] text-zinc-500 mb-2">{subtitle}</p>}
      {children}
    </div>
  );
}

function ErrorBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} className="text-rose-300 mt-0.5 shrink-0" />
        <div className="flex-1 text-[11px] leading-relaxed">
          <div className="font-semibold text-rose-200">{label}</div>
          <div className="text-rose-200/80 mt-0.5">{children}</div>
          <div className="text-rose-200/60 mt-1.5">
            Verifique <strong>Subdomínio</strong> e <strong>Access Token</strong> do Kommo
            mais acima nesta tela.
          </div>
        </div>
      </div>
    </div>
  );
}
