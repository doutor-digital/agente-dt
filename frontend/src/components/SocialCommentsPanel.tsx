// ============================================================================
// InstagramPanel — o canal de comentários inteiro numa tela só.
//
// LÓGICA DE PRODUTO
// -----------------
// Duas abas, porque são dois momentos diferentes da vida do canal:
//
//   CONFIGURAÇÃO — usada uma vez, no dia em que se liga o canal. Aqui mora o
//   passo a passo, porque metade do trabalho é do lado da Meta e não do nosso:
//   sem a URL do webhook cadastrada lá, nada chega e a fila fica vazia sem
//   explicação. Por isso a URL vem pronta e com botão de copiar — e é a URL do
//   BACKEND, não a do front, que são domínios diferentes em produção.
//
//   FILA — usada todo dia. Desenhada em torno de UMA pergunta: "posso soltar
//   esse texto no meu perfil?". O cartão mostra o comentário e as DUAS
//   respostas lado a lado, porque julgar uma sem a outra não dá: a pública
//   sozinha parece vazia ("te chamei no direct"), e o direct sozinho não
//   mostra o que ficou exposto pra todo mundo ver.
//
// Os dois textos são editáveis antes de aprovar — o rascunho da IA é sugestão,
// não decisão. Se o moderador tivesse que recusar tudo que "quase serve", a
// fila viraria trabalho em vez de economia.
// ============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
// Ícones: Phosphor (traço mais suave e cantos arredondados) + as marcas do
// Font Awesome, ambos via react-icons.
import {
  PiWarningCircleBold,
  PiArrowRightBold,
  PiCheckBold,
  PiCheckCircleFill,
  PiCircleBold,
  PiCopyBold,
  PiSpinnerGapBold,
  PiChatCircleDotsBold,
  PiArrowsClockwiseBold,
  PiPaperPlaneTiltBold,
  PiSlidersHorizontalBold,
  PiRadioButtonBold,
  PiShieldCheckBold,
  PiSparkleBold,
  PiXBold,
} from 'react-icons/pi';
import { FaInstagram, FaFacebookF } from 'react-icons/fa6';
import { api, webhookUrl } from '../lib/api';
import { useUnit } from '../context/UnitContext';
import type {
  IgCommentCategory,
  KommoLeadCustomField,
  IgCommentStatus,
  InstagramComment,
  InstagramCommentsResponse,
  Unit,
} from '../types/api';

// ---------------------------------------------------------------------------
// A rede como parâmetro
// ---------------------------------------------------------------------------
// Instagram e Facebook resolvem o MESMO problema (comentário público → conversa
// privada) com credenciais e endpoints diferentes. Duplicar a tela significaria
// corrigir cada ajuste duas vezes e, na prática, uma das cópias envelhecer. Só
// o que realmente muda vira dado aqui.

export type SocialPlatform = 'instagram' | 'facebook';

interface PlatformSkin {
  label: string;
  privado: string;
  Brand: typeof FaInstagram;
  gradiente: string;
  campos: {
    enabled: 'igEnabled' | 'fbEnabled';
    dryRun: 'igDryRun' | 'fbDryRun';
    accountId: 'igUserId' | 'fbPageId';
    accessToken: 'igAccessToken' | 'fbAccessToken';
    verifyToken: 'igVerifyToken' | 'fbVerifyToken';
    appSecret: 'igAppSecret' | 'fbAppSecret';
    whatsapp: 'igWhatsappNumber' | 'fbWhatsappNumber';
    assinatura: 'igPublicSignature' | 'fbPublicSignature';
    modo: 'igDeliveryMode' | 'fbDeliveryMode';
    campoResposta: 'igReplyFieldId' | 'fbReplyFieldId';
    prompt: 'igCommentPrompt' | 'fbCommentPrompt';
  };
  contaLabel: string;
  contaHint: string;
}

const SKIN: Record<SocialPlatform, PlatformSkin> = {
  instagram: {
    label: 'Instagram',
    privado: 'direct',
    Brand: FaInstagram,
    gradiente: 'conic-gradient(from 210deg, #f9ce34, #ee2a7b, #6228d7, #f9ce34)',
    contaLabel: 'IG User ID',
    contaHint: 'ID numérico da conta Profissional — não é o @.',
    campos: {
      enabled: 'igEnabled', dryRun: 'igDryRun', accountId: 'igUserId',
      accessToken: 'igAccessToken', verifyToken: 'igVerifyToken', appSecret: 'igAppSecret',
      whatsapp: 'igWhatsappNumber', assinatura: 'igPublicSignature',
      modo: 'igDeliveryMode', campoResposta: 'igReplyFieldId', prompt: 'igCommentPrompt',
    },
  },
  facebook: {
    label: 'Facebook',
    privado: 'privado',
    Brand: FaFacebookF,
    gradiente: 'conic-gradient(from 210deg, #1877f2, #4267b2, #0a3d8f, #1877f2)',
    contaLabel: 'Page ID',
    contaHint: 'ID numérico da Página — aparece em Configurações → Informações.',
    campos: {
      enabled: 'fbEnabled', dryRun: 'fbDryRun', accountId: 'fbPageId',
      accessToken: 'fbAccessToken', verifyToken: 'fbVerifyToken', appSecret: 'fbAppSecret',
      whatsapp: 'fbWhatsappNumber', assinatura: 'fbPublicSignature',
      modo: 'fbDeliveryMode', campoResposta: 'fbReplyFieldId', prompt: 'fbCommentPrompt',
    },
  },
};

// ---------------------------------------------------------------------------
// Vocabulário visual
// ---------------------------------------------------------------------------

const CATEGORY: Record<IgCommentCategory, { label: string; chip: string; dot: string }> = {
  ELOGIO: { label: 'Elogio', chip: 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/25', dot: 'bg-emerald-400' },
  PRECO: { label: 'Preço', chip: 'text-amber-300 bg-amber-500/10 ring-amber-500/25', dot: 'bg-amber-400' },
  CLINICA: { label: 'Dúvida clínica', chip: 'text-sky-300 bg-sky-500/10 ring-sky-500/25', dot: 'bg-sky-400' },
  AGENDAR: { label: 'Quer agendar', chip: 'text-violet-300 bg-violet-500/10 ring-violet-500/25', dot: 'bg-violet-400' },
  SPAM: { label: 'Spam', chip: 'text-rose-300 bg-rose-500/10 ring-rose-500/25', dot: 'bg-rose-400' },
  OUTRO: { label: 'Outro', chip: 'text-zinc-300 bg-zinc-500/10 ring-zinc-500/25', dot: 'bg-zinc-400' },
};

const STATUS_TABS: Array<{ id: IgCommentStatus | 'ALL'; label: string }> = [
  { id: 'PENDING', label: 'Aguardando' },
  { id: 'SENT', label: 'Publicados' },
  { id: 'SKIPPED', label: 'Ignorados' },
  { id: 'FAILED', label: 'Falharam' },
  { id: 'ALL', label: 'Tudo' },
];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ===========================================================================
// Página
// ===========================================================================

export default function SocialCommentsPanel({
  platform = 'instagram',
}: {
  platform?: SocialPlatform;
}) {
  const { selectedUnit: unit, refresh } = useUnit();
  const skin = SKIN[platform];
  const [view, setView] = useState<'fila' | 'config'>('fila');
  const ligado = unit ? Boolean(unit[skin.campos.enabled]) : false;

  // Sem canal configurado, cair na fila é cair numa tela vazia sem explicação.
  useEffect(() => {
    if (unit && !ligado) setView('config');
  }, [unit?.id, ligado]);

  if (!unit) {
    return <p className="text-sm text-zinc-400">Selecione um agente.</p>;
  }

  // O shell do app NÃO dá padding nem scroll — cada painel monta o seu, como
  // fazem CapturesPanel e DashboardPanel. Sem esse wrapper o conteúdo cola nas
  // bordas e a página não rola: era exatamente o "espremido" que aparecia com
  // a barra lateral recolhida.
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1500px] space-y-7 p-8">
        <PageHeader unit={unit} skin={skin} view={view} onView={setView} />
        {view === 'fila' ? (
          <Queue unit={unit} skin={skin} platform={platform} onGoConfig={() => setView('config')} />
        ) : (
          <Setup unit={unit} skin={skin} onSaved={refresh} />
        )}
      </div>
    </div>
  );
}

function PageHeader({
  unit,
  skin,
  view,
  onView,
}: {
  unit: Unit;
  skin: PlatformSkin;
  view: 'fila' | 'config';
  onView: (v: 'fila' | 'config') => void;
}) {
  const Brand = skin.Brand;
  return (
    <header className="relative overflow-hidden surface p-7">
      {/* Fundo com o gradiente do Instagram, bem discreto — dá identidade de
          canal sem competir com o conteúdo. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-16 h-56 w-56 rounded-full blur-3xl opacity-[0.18]"
        style={{ background: skin.gradiente }}
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow flex items-center gap-1.5">
            <Brand size={12} /> Canal
          </div>
          <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100">
            Comentários do {skin.label}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            O agente classifica cada comentário, responde em público com um texto seguro e
            escreve a mensagem no {skin.privado} que leva a pessoa pro WhatsApp.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <StatusPill unit={unit} skin={skin} />
          <div className="flex rounded-lg border border-zinc-800 p-0.5">
            {(['fila', 'config'] as const).map((v) => (
              <button
                key={v}
                onClick={() => onView(v)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {v === 'fila' ? <PiChatCircleDotsBold size={13} /> : <PiSlidersHorizontalBold size={13} />}
                {v === 'fila' ? 'Fila' : 'Configuração'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

function StatusPill({ unit, skin }: { unit: Unit; skin: PlatformSkin }) {
  const [tone, label] = !unit[skin.campos.enabled]
    ? (['text-zinc-400 bg-zinc-500/10 ring-zinc-500/25', 'Desligado'] as const)
    : unit[skin.campos.dryRun]
      ? (['text-sky-300 bg-sky-500/10 ring-sky-500/25', 'Revisão manual'] as const)
      : (['text-emerald-300 bg-emerald-500/10 ring-emerald-500/25', 'Publicando'] as const);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ring-1 ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

// ===========================================================================
// Configuração
// ===========================================================================

function Setup({
  unit,
  skin,
  onSaved,
}: {
  unit: Unit;
  skin: PlatformSkin;
  onSaved: () => Promise<void>;
}) {
  const f = skin.campos;
  const [draft, setDraft] = useState({
    enabled: Boolean(unit[f.enabled]),
    dryRun: Boolean(unit[f.dryRun]),
    modo: (unit[f.modo] as string) ?? 'kommo',
    campoResposta: (unit[f.campoResposta] as number | null) ?? null,
    prompt: (unit[f.prompt] as string | null) ?? '',
    accountId: (unit[f.accountId] as string | null) ?? '',
    accessToken: '',
    verifyToken: '',
    appSecret: '',
    whatsapp: (unit[f.whatsapp] as string | null) ?? '',
    assinatura: (unit[f.assinatura] as string | null) ?? '',
  });
  const [fields, setFields] = useState<KommoLeadCustomField[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const viaKommo = draft.modo === 'kommo';

  // Lista de campos do Kommo só faz sentido no modo Kommo — e é chamada de
  // rede na API deles, então não vale puxar quando não vai ser usada.
  useEffect(() => {
    if (!viaKommo) return;
    let vivo = true;
    void api
      .kommoLeadCustomFields(unit.id)
      .then((r) => vivo && setFields(r.fields ?? []))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [unit.id, viaKommo]);

  async function save() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      // Segredo em branco = "não mexer". Mandar '' apagaria o que já está lá,
      // e o campo vem sempre vazio porque a API devolve mascarado.
      const payload: Record<string, unknown> = {
        [f.enabled]: draft.enabled,
        [f.dryRun]: draft.dryRun,
        [f.modo]: draft.modo,
        [f.campoResposta]: draft.campoResposta ?? null,
        [f.prompt]: draft.prompt.trim() || null,
        [f.accountId]: draft.accountId.trim() || null,
        [f.whatsapp]: draft.whatsapp.trim() || null,
        [f.assinatura]: draft.assinatura.trim() || null,
      };
      if (draft.accessToken.trim()) payload[f.accessToken] = draft.accessToken.trim();
      if (draft.verifyToken.trim()) payload[f.verifyToken] = draft.verifyToken.trim();
      if (draft.appSecret.trim()) payload[f.appSecret] = draft.appSecret.trim();

      await api.updateUnit(unit.id, payload);
      await onSaved();
      setDraft((d) => ({ ...d, accessToken: '', verifyToken: '', appSecret: '' }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  }

  const faltam = viaKommo
    ? [!unit[f.campoResposta] && 'campo do Kommo', !unit[f.enabled] && 'ligar o canal'].filter(Boolean)
    : [
        !unit[f.accountId] && skin.contaLabel,
        !unit[f.accessToken] && 'Access Token',
        !unit[f.enabled] && 'ligar o canal',
      ].filter(Boolean);

  return (
    <div className="space-y-7 pb-28">
      {/* Duas colunas em telas largas: sem isso a página vira uma coluna fina
          no meio de dois desertos — foi a reclamação de "espremido". */}
      <div className="grid gap-5 xl:grid-cols-2">
        <section className="surface p-7">
          <SectionTitle
            title="Por onde a resposta sai"
            desc="Define o que o agente precisa e o que você tem que configurar."
          />
          <div className="mt-5 space-y-3">
            <ModeCard
              active={viaKommo}
              onClick={() => setDraft({ ...draft, modo: 'kommo' })}
              title="Pelo Kommo"
              badge="recomendado"
              desc="O comentário vira lead pela integração nativa do Kommo, o agente responde e o Salesbot entrega. Não depende do nosso App Review na Meta."
            />
            <ModeCard
              active={!viaKommo}
              onClick={() => setDraft({ ...draft, modo: 'direct' })}
              title="Direto na Meta"
              desc={`Falamos com a Graph API por conta própria: resposta no comentário e ${skin.privado} automático. Exige App Review aprovado.`}
            />
          </div>
        </section>

        <section className="surface p-7">
          <SectionTitle title="Como o agente deve agir" desc="Vale só para este canal." />
          <div className="mt-5 space-y-3">
            <SwitchRow
              checked={draft.enabled}
              onChange={(v) => setDraft({ ...draft, enabled: v })}
              title={`Ligar o agente de comentários do ${skin.label}`}
              desc="Desligado, o que chegar é descartado."
            />
            <SwitchRow
              checked={draft.dryRun}
              onChange={(v) => setDraft({ ...draft, dryRun: v })}
              title="Modo revisão"
              desc="O agente escreve tudo mas não publica — você aprova na fila. Deixe ligado até confiar no texto."
              accent="sky"
            />
          </div>
        </section>
      </div>

      {/* O prompt ocupa a largura toda: é o campo que mais precisa de espaço. */}
      <section className="surface p-7">
        <SectionTitle
          title="Instrução do agente"
          desc={`Como ele deve escrever a mensagem que leva a pessoa pro ${skin.privado}.`}
        />
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <textarea
            className="field min-h-[240px] leading-relaxed"
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            placeholder={`- 2 a 3 frases, tom caloroso e direto.
- Se a pessoa citou uma dor, acolha em uma frase antes de conduzir.
- Convide pra continuar no privado, sem pressionar.`}
          />
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            <p className="text-xs font-medium text-zinc-300">
              Quatro limites entram sempre, mesmo que você escreva o contrário
            </p>
            <ul className="mt-2.5 space-y-1.5 text-xs leading-relaxed text-zinc-500">
              <li>· nada de diagnóstico, exame ou remédio</li>
              <li>· nada de preço, valor ou desconto</li>
              <li>· nada de promessa de cura ou resultado</li>
              <li>· não se anuncia como IA, mas assume se perguntarem</li>
            </ul>
            <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
              Não é desconfiança do texto — é que esses quatro protegem contra dado de saúde
              exposto e preço dito por quem não deveria. Vazio usa a instrução padrão.
            </p>
          </div>
        </div>
      </section>

      {/* Credenciais / entrega */}
      {viaKommo ? (
        <section className="surface p-7">
          <SectionTitle
            title="Entrega pelo Salesbot"
            desc="O mesmo caminho que a IA já usa no WhatsApp: a resposta é escrita num campo e o Salesbot envia."
          />
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-zinc-300">Campo da resposta</span>
              <select
                className="field mt-1"
                value={draft.campoResposta ?? ''}
                onChange={(e) =>
                  setDraft({ ...draft, campoResposta: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">
                  {fields.length ? 'Escolha um campo do Kommo…' : 'Carregando campos do Kommo…'}
                </option>
                {fields.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} · {k.id}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
                Pode ser o mesmo campo do WhatsApp ou um só pra comentário — separado permite
                um gatilho diferente no Digital Pipeline.
              </span>
            </label>
            <TextField
              label="WhatsApp do convite"
              value={draft.whatsapp}
              onChange={(v) => setDraft({ ...draft, whatsapp: v })}
              placeholder="5599999999999"
              hint="DDI + DDD, só dígitos. Vira link no privado — nunca no comentário público."
            />
          </div>
        </section>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className="surface p-7">
            <SectionTitle
              title="Webhook na Meta"
              desc={`No painel do seu app, em Webhooks, assine o objeto ${skin.label} e marque o campo de comentários.`}
            />
            <CopyField
              label="Callback URL"
              value={webhookUrl(unit.slug, skin.label === 'Facebook' ? 'facebook' : 'instagram')}
              className="mt-4"
            />
            <p className="mt-2 text-xs text-zinc-500">
              É o endereço do backend, não o do painel — são domínios diferentes.
            </p>
          </section>

          <section className="surface p-7">
            <SectionTitle title="Credenciais" desc="" />
            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <TextField
                label={skin.contaLabel}
                value={draft.accountId}
                onChange={(v) => setDraft({ ...draft, accountId: v })}
                hint={skin.contaHint}
              />
              <TextField
                label="WhatsApp do convite"
                value={draft.whatsapp}
                onChange={(v) => setDraft({ ...draft, whatsapp: v })}
                placeholder="5599999999999"
                hint="DDI + DDD, só dígitos."
              />
              <SecretField
                label="Access Token"
                value={draft.accessToken}
                onChange={(v) => setDraft({ ...draft, accessToken: v })}
                filled={!!unit[f.accessToken]}
                hint="Token da Página com permissão de comentários e mensagens."
              />
              <SecretField
                label="Verify Token"
                value={draft.verifyToken}
                onChange={(v) => setDraft({ ...draft, verifyToken: v })}
                filled={!!unit[f.verifyToken]}
                hint="Uma senha sua, a mesma que você digita na Meta. Vazio herda a do WhatsApp."
              />
              <SecretField
                label="App Secret"
                value={draft.appSecret}
                onChange={(v) => setDraft({ ...draft, appSecret: v })}
                filled={!!unit[f.appSecret]}
                hint="Só se estiver em outro app. Vazio herda o do WhatsApp."
              />
              <TextField
                label="Assinatura pública"
                value={draft.assinatura}
                onChange={(v) => setDraft({ ...draft, assinatura: v })}
                placeholder="— Equipe DH"
                hint="Opcional. Vai no fim de toda resposta pública."
              />
            </div>
          </section>
        </div>
      )}

      <div className="sticky bottom-4 flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/90 px-4 py-3 backdrop-blur">
        <button className="btn-primary" onClick={() => void save()} disabled={saving}>
          {saving ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiCheckBold size={14} />}
          Salvar
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
            <PiCheckCircleFill size={13} /> salvo
          </span>
        )}
        {err && <span className="text-xs text-rose-300">{err}</span>}
        <span className="ml-auto">
          {faltam.length === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
              <PiCheckCircleFill size={13} /> tudo configurado
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
              <PiCircleBold size={13} /> falta: {faltam.join(', ')}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function SectionTitle({ title, desc }: { title: string; desc: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
      {desc && <p className="mt-1 text-sm leading-relaxed text-zinc-400">{desc}</p>}
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  desc,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-colors ${
        active ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-zinc-800 hover:bg-zinc-900'
      }`}
    >
      <span className="flex items-center gap-2">
        <PiRadioButtonBold size={14} className={active ? 'text-emerald-400' : 'text-zinc-600'} />
        <span className="text-sm font-medium text-zinc-100">{title}</span>
        {badge && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/25">
            {badge}
          </span>
        )}
      </span>
      <span className="mt-2 block text-xs leading-relaxed text-zinc-400">{desc}</span>
    </button>
  );
}

// ===========================================================================
// Fila
// ===========================================================================

function Queue({
  unit,
  skin,
  platform,
  onGoConfig,
}: {
  unit: Unit;
  skin: PlatformSkin;
  platform: SocialPlatform;
  onGoConfig: () => void;
}) {
  const [status, setStatus] = useState<IgCommentStatus | 'ALL'>('PENDING');
  const [data, setData] = useState<InstagramCommentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await api.instagramComments(unit.id, {
          status: status === 'ALL' ? undefined : status,
          platform,
          limit: 100,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar');
    } finally {
      setLoading(false);
    }
  }, [unit.id, status, platform]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = data?.counts ?? {};

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Aguardando você" value={counts.PENDING ?? 0} tone="amber" icon={PiShieldCheckBold} />
        <Stat label="Publicados" value={counts.SENT ?? 0} tone="emerald" icon={PiPaperPlaneTiltBold} />
        <Stat label="Ignorados" value={counts.SKIPPED ?? 0} tone="zinc" icon={PiXBold} />
        <Stat label="Falharam" value={counts.FAILED ?? 0} tone="rose" icon={PiWarningCircleBold} />
      </div>

      {!unit[skin.campos.enabled] && (
        <button
          onClick={onGoConfig}
          className="surface flex w-full items-center gap-3 border-amber-500/25 p-4 text-left transition-colors hover:bg-zinc-900"
        >
          <PiWarningCircleBold size={16} className="shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-zinc-200">Canal desligado</p>
            <p className="mt-0.5 text-zinc-400">
              Nada é processado enquanto isso. Abra a configuração para ligar.
            </p>
          </div>
          <PiArrowRightBold size={15} className="shrink-0 text-zinc-500" />
        </button>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((t) => {
            const n = t.id === 'ALL' ? undefined : counts[t.id];
            return (
              <button
                key={t.id}
                onClick={() => setStatus(t.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  status === t.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                }`}
              >
                {t.label}
                {n !== undefined && n > 0 && <span className="ml-1.5 text-zinc-500">{n}</span>}
              </button>
            );
          })}
        </div>
        <button className="btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiArrowsClockwiseBold size={14} />}
          Atualizar
        </button>
      </div>

      {error && (
        <div className="surface flex items-start gap-2 border-rose-500/30 p-4 text-sm text-rose-300">
          <PiWarningCircleBold size={16} className="mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="surface flex items-center justify-center p-12 text-zinc-500">
          <PiSpinnerGapBold size={18} className="animate-spin" />
        </div>
      )}

      {data && data.comments.length === 0 && !loading && (
        <div className="surface p-16 text-center">
          <PiSparkleBold size={22} className="mx-auto text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-400">
            {status === 'PENDING'
              ? 'Nenhum comentário esperando aprovação.'
              : 'Nada por aqui ainda.'}
          </p>
        </div>
      )}

      <div className="space-y-4">
        {data?.comments.map((c) => (
          <CommentCard key={c.id} unitId={unit.id} skin={skin} comment={c} onDone={load} />
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: 'amber' | 'emerald' | 'rose' | 'zinc';
  icon: typeof PiPaperPlaneTiltBold;
}) {
  const color = {
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    rose: 'text-rose-400',
    zinc: 'text-zinc-500',
  }[tone];
  return (
    <div className="surface p-5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-zinc-400">{label}</span>
        <Icon size={14} className={color} />
      </div>
      <p className={`mt-3 text-3xl font-semibold tabular-nums ${value > 0 ? 'text-zinc-100' : 'text-zinc-600'}`}>
        {value}
      </p>
    </div>
  );
}

function CommentCard({
  unitId,
  skin,
  comment,
  onDone,
}: {
  unitId: string;
  skin: PlatformSkin;
  comment: InstagramComment;
  onDone: () => void | Promise<void>;
}) {
  const [publicReply, setPublicReply] = useState(comment.publicReply ?? '');
  const [privateReply, setPrivateReply] = useState(comment.privateReply ?? '');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const editable = comment.status === 'PENDING' || comment.status === 'FAILED';
  const cat = CATEGORY[comment.category];
  const dirty = useMemo(
    () => publicReply !== (comment.publicReply ?? '') || privateReply !== (comment.privateReply ?? ''),
    [publicReply, privateReply, comment.publicReply, comment.privateReply],
  );

  async function run(kind: 'approve' | 'reject') {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === 'approve') {
        await api.approveInstagramComment(unitId, comment.id, {
          publicReply: publicReply.trim() || null,
          privateReply: privateReply.trim() || null,
        });
      } else {
        await api.rejectInstagramComment(unitId, comment.id);
      }
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Falha na operação');
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="surface overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/70 px-4 py-2.5 text-xs">
        <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-medium ring-1 ${cat.chip}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${cat.dot}`} />
          {cat.label}
        </span>
        {comment.authorUsername && <span className="text-zinc-300">@{comment.authorUsername}</span>}
        <span className="text-zinc-600">{formatWhen(comment.createdAt)}</span>
        <span className="ml-auto">
          <StatusChip comment={comment} />
        </span>
      </div>

      <div className="p-5">
        <p className="border-l-2 border-zinc-700 pl-3 text-sm whitespace-pre-wrap text-zinc-200">
          {comment.text || <span className="italic text-zinc-500">(comentário sem texto)</span>}
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <ReplyBox
            label="Resposta pública"
            hint="Fica no post, visível pra todos."
            value={publicReply}
            onChange={setPublicReply}
            disabled={!editable}
            rows={2}
            sent={!!comment.publicSentAt}
          />
          <ReplyBox
            label={skin.privado === 'direct' ? 'Direct' : 'Mensagem privada'}
            hint="Privado. Uma única mensagem por comentário."
            value={privateReply}
            onChange={setPrivateReply}
            disabled={!editable}
            rows={4}
            sent={!!comment.privateSentAt}
          />
        </div>

        {comment.error && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-rose-300">
            <PiWarningCircleBold size={13} className="mt-0.5 shrink-0" />
            {comment.error}
          </p>
        )}
        {err && <p className="mt-3 text-xs text-rose-300">{err}</p>}

        {editable && (
          <div className="mt-4 flex items-center gap-2">
            <button className="btn-primary" onClick={() => void run('approve')} disabled={busy !== null}>
              {busy === 'approve' ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiCheckBold size={14} />}
              Publicar{dirty ? ' com as edições' : ''}
            </button>
            <button className="btn-ghost" onClick={() => void run('reject')} disabled={busy !== null}>
              {busy === 'reject' ? <PiSpinnerGapBold size={14} className="animate-spin" /> : <PiXBold size={14} />}
              Não responder
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function StatusChip({ comment }: { comment: InstagramComment }) {
  if (comment.status === 'SENT') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400">
        <PiCheckBold size={12} />
        {comment.privateSentAt ? 'público + privado' : 'público'}
      </span>
    );
  }
  if (comment.status === 'FAILED') return <span className="text-rose-400">falhou</span>;
  if (comment.status === 'SKIPPED') {
    return (
      <span className="text-zinc-500">
        ignorado{comment.skipReason ? ` · ${comment.skipReason}` : ''}
      </span>
    );
  }
  if (comment.skipReason === 'confianca_baixa') {
    return <span className="text-amber-400">classificação incerta</span>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Peças de formulário
// ---------------------------------------------------------------------------

function CopyField({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // clipboard bloqueado (http, permissão): o texto continua selecionável.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }
  return (
    <div className={className}>
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <div className="mt-1 flex items-stretch gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="field flex-1 font-mono text-xs"
        />
        <button className="btn-ghost shrink-0" onClick={() => void copy()}>
          {copied ? <PiCheckBold size={14} className="text-emerald-400" /> : <PiCopyBold size={14} />}
          {copied ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-zinc-300">{label}</span>
      <input
        className="field mt-1"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">{hint}</span>}
    </label>
  );
}

function SecretField({
  label,
  value,
  onChange,
  hint,
  filled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  filled: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        {label}
        {filled && (
          <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-400">
            <PiCheckCircleFill size={11} /> salvo
          </span>
        )}
      </span>
      <input
        type="password"
        className="field mt-1"
        value={value}
        placeholder={filled ? '•••••••• (deixe vazio pra manter)' : ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">{hint}</span>}
    </label>
  );
}

function SwitchRow({
  checked,
  onChange,
  title,
  desc,
  accent = 'emerald',
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
  accent?: 'emerald' | 'sky';
}) {
  const on = accent === 'sky' ? 'bg-sky-500' : 'bg-emerald-500';
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-zinc-800 p-3 text-left transition-colors hover:bg-zinc-900"
    >
      <span
        className={`mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? on : 'bg-zinc-700'
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-200">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-zinc-400">{desc}</span>
      </span>
    </button>
  );
}

function ReplyBox({
  label,
  hint,
  value,
  onChange,
  disabled,
  rows,
  sent,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows: number;
  sent: boolean;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-2 text-xs font-medium text-zinc-300">
        {label}
        {sent && (
          <span className="inline-flex items-center gap-1 text-[10px] font-normal text-emerald-400">
            <PiCheckBold size={11} /> enviado
          </span>
        )}
      </span>
      <span className="mt-0.5 mb-1 block text-[11px] text-zinc-500">{hint}</span>
      <textarea
        className="field text-sm"
        rows={rows}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={disabled ? '' : '(vazio = não envia)'}
      />
    </label>
  );
}
