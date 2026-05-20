// ============================================================================
// UsersPanel — gestão de admins (super admin convida unit admins).
//
// Acesso: só SUPER_ADMIN (a aba some no sidebar pra outros roles e o
// backend também rejeita).
//
// Convite implícito: o super admin cadastra email + role (+ unitId se
// UNIT_ADMIN). Não envia email — o convidado simplesmente entra com Google
// usando esse email e a sessão é criada com o role/unit cadastrados.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Save, Trash2, UserCheck, UserX } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../lib/api';
import type { AdminUser, AdminUserInput, UserRole } from '../types/api';
import { useUnit } from '../context/UnitContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export function UsersPanel() {
  const { user: currentUser } = useAuth();
  const { units } = useUnit();
  const toast = useToast();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<AdminUserInput>({
    email: '',
    name: '',
    role: 'UNIT_ADMIN',
    unitId: units[0]?.id ?? null,
  });
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listUsers();
      setUsers(list);
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error ?? 'falha ao carregar usuários');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!draft.email || !draft.email.includes('@')) {
      toast.error('email inválido');
      return;
    }
    if (draft.role === 'UNIT_ADMIN' && !draft.unitId) {
      toast.error('selecione uma unidade');
      return;
    }
    setSaving(true);
    try {
      await api.createUser({
        email: draft.email.toLowerCase(),
        name: draft.name?.trim() || null,
        role: draft.role,
        unitId: draft.role === 'UNIT_ADMIN' ? draft.unitId : null,
      });
      setCreating(false);
      setDraft({ email: '', name: '', role: 'UNIT_ADMIN', unitId: units[0]?.id ?? null });
      await refresh();
      toast.success('usuário convidado');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error ?? 'falha ao criar');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(u: AdminUser) {
    if (u.id === currentUser?.id) {
      toast.error('não dá pra desativar a si mesmo');
      return;
    }
    try {
      await api.updateUser(u.id, { isActive: !u.isActive });
      await refresh();
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error ?? 'falha');
    }
  }

  async function handleDelete(u: AdminUser) {
    if (u.id === currentUser?.id) {
      toast.error('não dá pra apagar a si mesmo');
      return;
    }
    if (!confirm(`Remover acesso de ${u.email}?`)) return;
    try {
      await api.deleteUser(u.id);
      await refresh();
      toast.success('removido');
    } catch (err) {
      const e = err as { response?: { data?: { error?: string } } };
      toast.error(e.response?.data?.error ?? 'falha');
    }
  }

  function unitName(unitId: string | null): string {
    if (!unitId) return '—';
    return units.find((u) => u.id === unitId)?.name ?? unitId.slice(0, 8);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Usuários</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Convide UNIT_ADMIN por email. O convidado entra pelo Google usando esse email.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 rounded bg-brand-500/10 text-brand-300 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/20"
          >
            <Plus size={12} />
            Convidar
          </button>
        )}
      </div>

      {creating && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 mb-4">
          <h3 className="text-sm font-semibold text-zinc-100 mb-3">Novo usuário</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              label="Email da conta Google"
              value={draft.email}
              onChange={(v) => setDraft({ ...draft, email: v })}
            />
            <Field
              label="Nome (opcional)"
              value={draft.name ?? ''}
              onChange={(v) => setDraft({ ...draft, name: v })}
            />
            <div>
              <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">
                Role
              </label>
              <select
                value={draft.role}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    role: e.target.value as UserRole,
                    unitId: e.target.value === 'SUPER_ADMIN' ? null : (draft.unitId ?? units[0]?.id ?? null),
                  })
                }
                className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
              >
                <option value="UNIT_ADMIN">UNIT_ADMIN (vê só uma unidade)</option>
                <option value="SUPER_ADMIN">SUPER_ADMIN (vê tudo)</option>
              </select>
            </div>
            {draft.role === 'UNIT_ADMIN' && (
              <div>
                <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">
                  Unidade
                </label>
                <select
                  value={draft.unitId ?? ''}
                  onChange={(e) => setDraft({ ...draft, unitId: e.target.value || null })}
                  className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
                >
                  <option value="">— selecione —</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} (/{u.slug})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-brand-500/20 text-brand-200 ring-1 ring-brand-500/30 inline-flex items-center gap-1 hover:bg-brand-500/30 disabled:opacity-50"
            >
              {saving ? <Loader2 className="animate-spin" size={12} /> : <Save size={12} />}
              Convidar
            </button>
            <button
              type="button"
              onClick={() => setCreating(false)}
              className="text-xs px-3 py-1.5 rounded text-zinc-400 hover:bg-zinc-800/60"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900/30">
        {loading ? (
          <div className="p-8 text-center">
            <Loader2 className="animate-spin text-zinc-500 mx-auto" size={20} />
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-xs text-zinc-500">Nenhum usuário cadastrado.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-zinc-900/60 text-zinc-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-[10px]">Email</th>
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-[10px]">Nome</th>
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-[10px]">Role</th>
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-[10px]">Unidade</th>
                <th className="px-4 py-2 text-left font-medium uppercase tracking-wider text-[10px]">Último login</th>
                <th className="px-4 py-2 text-right font-medium uppercase tracking-wider text-[10px]">Ações</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className={clsx(
                    'border-t border-zinc-800/60',
                    !u.isActive && 'opacity-50',
                  )}
                >
                  <td className="px-4 py-2 text-zinc-200">{u.email}</td>
                  <td className="px-4 py-2 text-zinc-400">{u.name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={clsx(
                        'inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wider',
                        u.role === 'SUPER_ADMIN'
                          ? 'bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30'
                          : 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/30',
                      )}
                    >
                      {u.role === 'SUPER_ADMIN' ? 'Super' : 'Unit'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{unitName(u.unitId)}</td>
                  <td className="px-4 py-2 text-zinc-500">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : 'nunca'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleToggleActive(u)}
                        title={u.isActive ? 'Desativar' : 'Reativar'}
                        className="p-1.5 rounded text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800/60"
                      >
                        {u.isActive ? <UserX size={13} /> : <UserCheck size={13} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(u)}
                        title="Remover"
                        className="p-1.5 rounded text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-zinc-500 block mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md bg-zinc-950/60 ring-1 ring-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      />
    </div>
  );
}
