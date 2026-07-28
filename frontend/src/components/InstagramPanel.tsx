// ============================================================================
// InstagramPanel — configuração do canal + fila de aprovação dos comentários.
//
// LÓGICA DE PRODUTO
// -----------------
// A tela é desenhada em torno de UMA pergunta: "posso soltar esse texto no meu
// perfil?". Por isso o cartão mostra, lado a lado, o comentário que chegou e
// as DUAS respostas — a pública e o direct. Ver uma sem a outra não permite
// julgar: a pública sozinha parece vazia ("te chamei no direct"), e o direct
// sozinho não mostra o que ficou exposto.
//
// Os dois textos são editáveis antes de aprovar. O rascunho da IA é sugestão,
// não decisão — se o moderador precisasse recusar tudo que quase serve, a fila
// viraria trabalho em vez de economia.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Instagram,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type {
  IgCommentCategory,
  IgCommentStatus,
  InstagramComment,
  InstagramCommentsResponse,
} from '../types/api';

const CATEGORY_LABEL: Record<IgCommentCategory, string> = {
  ELOGIO: 'Elogio',
  PRECO: 'Preço',
  CLINICA: 'Dúvida clínica',
  AGENDAR: 'Quer agendar',
  SPAM: 'Spam',
  OUTRO: 'Outro',
};

const CATEGORY_STYLE: Record<IgCommentCategory, string> = {
  ELOGIO: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  PRECO: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  CLINICA: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
  AGENDAR: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  SPAM: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  OUTRO: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
};

const STATUS_TABS: Array<{ id: IgCommentStatus | 'ALL'; label: string }> = [
  { id: 'PENDING', label: 'Aguardando' },
  { id: 'SENT', label: 'Publicados' },
  { id: 'SKIPPED', label: 'Ignorados' },
  { id: 'FAILED', label: 'Falharam' },
  { id: 'ALL', label: 'Tudo' },
];

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function InstagramPanel() {
  const { selectedUnit: unit } = useUnit();
  const unitId = unit?.id ?? null;

  const [status, setStatus] = useState<IgCommentStatus | 'ALL'>('PENDING');
  const [data, setData] = useState<InstagramCommentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!unitId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.instagramComments(unitId, {
        status: status === 'ALL' ? undefined : status,
        limit: 100,
      });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar comentários');
    } finally {
      setLoading(false);
    }
  }, [unitId, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = data?.counts.PENDING ?? 0;

  if (!unit) {
    return <p className="text-sm text-zinc-400">Selecione um agente.</p>;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="eyebrow flex items-center gap-2">
            <Instagram size={13} /> Instagram
          </div>
          <h1 className="text-xl font-semibold text-zinc-100 mt-1">Comentários</h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-2xl">
            O agente classifica cada comentário, responde em público com um texto fixo e
            escreve o direct que puxa a pessoa pro WhatsApp.
          </p>
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Atualizar
        </button>
      </header>

      <ChannelStatus unit={unit} pending={pending} />

      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map((t) => {
          const count = t.id === 'ALL' ? undefined : data?.counts[t.id];
          const active = status === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setStatus(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                active
                  ? 'bg-zinc-800 text-zinc-100 border-zinc-700'
                  : 'bg-transparent text-zinc-400 border-transparent hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {t.label}
              {count !== undefined && count > 0 && (
                <span className="ml-1.5 text-zinc-500">{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="surface p-4 border-rose-500/30 text-sm text-rose-300 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="surface p-8 flex items-center justify-center text-zinc-500">
          <Loader2 size={18} className="animate-spin" />
        </div>
      )}

      {data && data.comments.length === 0 && !loading && (
        <div className="surface p-8 text-center">
          <MessageCircle size={22} className="mx-auto text-zinc-600" />
          <p className="text-sm text-zinc-400 mt-3">
            {status === 'PENDING'
              ? 'Nenhum comentário esperando aprovação.'
              : 'Nada por aqui ainda.'}
          </p>
        </div>
      )}

      <div className="space-y-3">
        {data?.comments.map((c) => (
          <CommentCard key={c.id} unitId={unit.id} comment={c} onDone={load} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Estado do canal — responde "por que nada está sendo publicado?"
// ---------------------------------------------------------------------------
// Três motivos deixam a fila parada, e são diferentes entre si: o canal está
// desligado, está em dry run, ou falta o número do WhatsApp. Mostrar os três
// juntos evita a caçada.

function ChannelStatus({
  unit,
  pending,
}: {
  unit: { igEnabled: boolean; igDryRun: boolean; igWhatsappNumber: string | null; slug: string };
  pending: number;
}) {
  if (!unit.igEnabled) {
    return (
      <div className="surface p-4 border-amber-500/25 flex items-start gap-3">
        <AlertTriangle size={16} className="text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="text-zinc-200 font-medium">Canal desligado</p>
          <p className="text-zinc-400 mt-0.5">
            Os comentários que chegarem no webhook são descartados. Ligue em{' '}
            <span className="text-zinc-300">Agentes → Instagram</span> depois de cadastrar a
            URL{' '}
            <code className="kbd">/api/webhooks/{unit.slug}/instagram</code> no app da Meta.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="surface p-4 flex items-start gap-3">
        {unit.igDryRun ? (
          <ShieldCheck size={16} className="text-sky-400 shrink-0 mt-0.5" />
        ) : (
          <Send size={16} className="text-emerald-400 shrink-0 mt-0.5" />
        )}
        <div className="text-sm">
          <p className="text-zinc-200 font-medium">
            {unit.igDryRun ? 'Modo revisão' : 'Publicando sozinho'}
          </p>
          <p className="text-zinc-400 mt-0.5">
            {unit.igDryRun
              ? `Nada vai pro perfil sem você aprovar${pending > 0 ? ` — ${pending} na fila` : ''}.`
              : 'O agente responde e manda o direct sem passar por aqui.'}
          </p>
        </div>
      </div>

      <div className="surface p-4 flex items-start gap-3">
        <MessageCircle
          size={16}
          className={unit.igWhatsappNumber ? 'text-emerald-400' : 'text-amber-400'}
        />
        <div className="text-sm">
          <p className="text-zinc-200 font-medium">Destino do direct</p>
          <p className="text-zinc-400 mt-0.5">
            {unit.igWhatsappNumber
              ? `Link do WhatsApp para ${unit.igWhatsappNumber}.`
              : 'Sem número configurado — o direct convida a responder no próprio Instagram.'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartão de um comentário.
// ---------------------------------------------------------------------------

function CommentCard({
  unitId,
  comment,
  onDone,
}: {
  unitId: string;
  comment: InstagramComment;
  onDone: () => void | Promise<void>;
}) {
  const [publicReply, setPublicReply] = useState(comment.publicReply ?? '');
  const [privateReply, setPrivateReply] = useState(comment.privateReply ?? '');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const editable = comment.status === 'PENDING' || comment.status === 'FAILED';

  const dirty = useMemo(
    () =>
      publicReply !== (comment.publicReply ?? '') || privateReply !== (comment.privateReply ?? ''),
    [publicReply, privateReply, comment.publicReply, comment.privateReply],
  );

  async function approve() {
    setBusy('approve');
    setErr(null);
    try {
      await api.approveInstagramComment(unitId, comment.id, {
        publicReply: publicReply.trim() || null,
        privateReply: privateReply.trim() || null,
      });
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Falha ao publicar');
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy('reject');
    setErr(null);
    try {
      await api.rejectInstagramComment(unitId, comment.id);
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Falha ao recusar');
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="surface p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`px-2 py-0.5 rounded-md border font-medium ${CATEGORY_STYLE[comment.category]}`}
        >
          {CATEGORY_LABEL[comment.category]}
        </span>
        {comment.authorUsername && (
          <span className="text-zinc-400">@{comment.authorUsername}</span>
        )}
        <span className="text-zinc-600">{formatWhen(comment.createdAt)}</span>
        <StatusChip comment={comment} />
      </div>

      <blockquote className="text-sm text-zinc-200 border-l-2 border-zinc-700 pl-3 whitespace-pre-wrap">
        {comment.text || <span className="text-zinc-500 italic">(comentário sem texto)</span>}
      </blockquote>

      <div className="grid gap-3 md:grid-cols-2">
        <ReplyBox
          label="Resposta pública"
          hint="Fica visível no post, para todos."
          value={publicReply}
          onChange={setPublicReply}
          disabled={!editable}
          rows={2}
        />
        <ReplyBox
          label="Direct"
          hint="Privado, uma única mensagem por comentário."
          value={privateReply}
          onChange={setPrivateReply}
          disabled={!editable}
          rows={4}
        />
      </div>

      {comment.error && (
        <p className="text-xs text-rose-300 flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          {comment.error}
        </p>
      )}
      {err && <p className="text-xs text-rose-300">{err}</p>}

      {editable && (
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={() => void approve()} disabled={busy !== null}>
            {busy === 'approve' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            Publicar{dirty ? ' com as edições' : ''}
          </button>
          <button className="btn-ghost" onClick={() => void reject()} disabled={busy !== null}>
            {busy === 'reject' ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
            Não responder
          </button>
        </div>
      )}
    </article>
  );
}

function StatusChip({ comment }: { comment: InstagramComment }) {
  if (comment.status === 'SENT') {
    return (
      <span className="text-emerald-400 flex items-center gap-1">
        <Check size={12} />
        {comment.privateSentAt ? 'público + direct' : 'público'}
      </span>
    );
  }
  if (comment.status === 'FAILED') return <span className="text-rose-400">falhou</span>;
  if (comment.status === 'SKIPPED') {
    return <span className="text-zinc-500">ignorado{comment.skipReason ? ` · ${comment.skipReason}` : ''}</span>;
  }
  if (comment.skipReason === 'confianca_baixa') {
    return <span className="text-amber-400">classificação incerta</span>;
  }
  return null;
}

function ReplyBox({
  label,
  hint,
  value,
  onChange,
  disabled,
  rows,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <span className="block text-[11px] text-zinc-500 mb-1">{hint}</span>
      <textarea
        className="field w-full text-sm"
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={disabled ? '' : '(vazio = não envia)'}
      />
    </label>
  );
}
