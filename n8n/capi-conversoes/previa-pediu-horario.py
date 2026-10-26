#!/usr/bin/env python3
"""PRÉVIA, SÓ LEITURA: quantos LeadSubmitted a mais o sinal "pediu horário" teria mandado nos últimos N dias.

Roda na VPS de produção (precisa do docker). Não escreve em nada: duas consultas SELECT em transação READ ONLY
(banco do agente e n8n_rastreio) e a conta é feita aqui, em memória.

O sinal é o do backend (src/lib/pediu-horario.ts): a Sofia acha ao menos 1 horário CONFIRMADO para oferecer
(`consultar_horarios ...: N confirmado(s)` com N >= 1 em execution_steps). A hora do pedido é a da PRIMEIRA vez.

Para cada cartão que consultou:
  - precisa ter clique de anúncio amarrado (ctwa_logs -> ctwa_eventos), com ou sem ctwa_clid ("Status");
  - o pedido tem de cair em até 7 dias depois do clique (o Lead só conta nesse prazo);
  - "já tinha Lead" = existe LeadSubmitted enviado (qualquer hora) até 1 h depois do pedido -> só antecipa, não soma;
  - "nunca teria Lead" = o cartão não tem LeadSubmitted enviado hoje -> volume novo de verdade.
Limites (honestos): não enxerga as etiquetas de exclusão ("Mora fora", "Fora do escopo") nem o funil do cartão, então
é um TETO para o volume novo; o volume real fica um pouco abaixo.

Uso:  previa-pediu-horario.py [--dias 30] [--unidade balsas]     (sem --unidade = todas)
"""
import argparse, collections, csv, datetime as dt, io, subprocess, sys

UTC = dt.timezone.utc


def sh(cmd):
    return subprocess.check_output(['bash', '-c', cmd], text=True)


def psql_agente(sql):
    return sh("DBID=$(docker ps -q -f name=ddagentdb_db | head -1); docker exec -i $DBID sh -c "
              "'PGPASSWORD=\"$POSTGRES_PASSWORD\" psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -X -A -F\"|\" --pset=footer=off "
              "-c \"BEGIN READ ONLY;\" -f -' <<'SQL'\n%s\nSQL" % sql)


def psql_rastreio(sql):
    return sh("PG=$(docker ps -q -f name=postgres_postgres | head -1); N8N=$(docker ps -q -f name=n8n_n8n_editor | head -1); "
              "export PGPASSWORD; PGPASSWORD=$(docker exec \"$N8N\" printenv DB_POSTGRESDB_PASSWORD); "
              "docker exec -i -e PGPASSWORD \"$PG\" psql -U postgres -d n8n_rastreio -X -A -F'|' --pset=footer=off "
              "-c 'BEGIN READ ONLY;' -f - <<'SQL'\n%s\nSQL" % sql)


def linhas(txt):
    L = [l for l in txt.splitlines() if l and l != 'BEGIN']
    return list(csv.DictReader(io.StringIO('\n'.join(L)), delimiter='|'))


def hora(s):
    s = s.strip()
    if '+' in s[10:] or '-' in s[11:]:
        return dt.datetime.fromisoformat(s.replace(' ', 'T', 1)).astimezone(UTC)
    return dt.datetime.fromisoformat(s.split('.')[0]).replace(tzinfo=UTC)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dias', type=int, default=30)
    ap.add_argument('--unidade', default='')
    a = ap.parse_args()
    d = a.dias
    # fila de busca um pouco maior que a janela: o clique pode ser até 7 dias anterior ao pedido
    consultas = linhas(psql_agente(f"""
select replace(replace(u.slug,'doutor-hernia-',''),'-resgate','') as unidade, t.lead_id, min(s.created_at at time zone 'UTC') as pedido_utc
from execution_steps s join execution_traces t on t.id = s.trace_id join units u on u.id = t.unit_id
where s.kind = 'TOOL_RESULT' and s.title ~ '^consultar_horarios [0-9-]+( \\([a-z]+\\))?: [1-9][0-9]* confirmado'
  and s.created_at > now() - interval '{d + 30} days'   -- olhar mais longe que a janela: o "primeiro pedido" tem de ser o primeiro de verdade
group by 1, 2;"""))
    cliques = linhas(psql_rastreio(f"""
select l.unidade, l.kommo_lead_id as lead_id, min(e.primeiro_contato_em at time zone 'UTC') as clique_utc, bool_or(e.ctwa_clid is not null) as tem_clid
from ctwa_logs l join ctwa_eventos e on e.wamid = l.wamid
where l.etapa = 'kommo' and l.status = 'sucesso' and l.kommo_lead_id is not null and e.primeiro_contato_em > now() - interval '{d + 16} days'
group by 1, 2;"""))
    leads = linhas(psql_rastreio("""
select unidade, kommo_lead_id as lead_id, min(enviado_em at time zone 'UTC') as t
from capi_envios where event_name = 'LeadSubmitted' and status = 'enviado' group by 1, 2;"""))

    cl = {(r['unidade'], r['lead_id']): (hora(r['clique_utc']), r['tem_clid'] == 't') for r in cliques}
    ls = {(r['unidade'], r['lead_id']): hora(r['t']) for r in leads}
    ini = dt.datetime.now(UTC) - dt.timedelta(days=d)
    res = collections.defaultdict(collections.Counter)
    for r in consultas:
        u, lead, t = r['unidade'], r['lead_id'], hora(r['pedido_utc'])
        if a.unidade and u != a.unidade:
            continue
        if t < ini:
            continue
        R = res[u]
        R['pediram'] += 1
        c = cl.get((u, lead))
        if not c:
            continue                      # sem clique de anúncio amarrado: orgânico/indicação, fora da Meta
        R['de anúncio'] += 1
        idade = (t - c[0]).total_seconds() / 86400
        if idade > 7 or idade < 0:
            R['clique > 7 dias'] += 1
            continue
        tipo = 'clid' if c[1] else 'status'
        if (u, lead) in ls and ls[(u, lead)] <= t + dt.timedelta(hours=1):
            R['já tinha Lead (só antecipa)'] += 1
            continue
        R['a mais ' + tipo] += 1
        if (u, lead) not in ls:
            R['NUNCA teria Lead ' + tipo] += 1
    base = collections.Counter(u for (u, _), t in ls.items() if t >= ini)
    print(f'Janela: últimos {d} dias. "Status" = anúncio sem ctwa_clid (só sai com page_id configurado).')
    print('unidade      pediram  de anúncio  já tinha  >7d  | a mais c/ clid  a mais Status | desses, nunca teriam Lead (clid/Status) | LeadSubmitted enviados no período')
    tot = collections.Counter()
    for u in sorted(res):
        R = res[u]
        tot.update(R)
        print(f"{u:12s} {R['pediram']:7d} {R['de anúncio']:11d} {R['já tinha Lead (só antecipa)']:9d} {R['clique > 7 dias']:4d}  | {R['a mais clid']:13d} {R['a mais status']:14d} | {R['NUNCA teria Lead clid']:18d} / {R['NUNCA teria Lead status']:<18d} | {base[u]}")
    if len(res) > 1:
        print(f"{'REDE':12s} {tot['pediram']:7d} {tot['de anúncio']:11d} {tot['já tinha Lead (só antecipa)']:9d} {tot['clique > 7 dias']:4d}  | {tot['a mais clid']:13d} {tot['a mais status']:14d} | {tot['NUNCA teria Lead clid']:18d} / {tot['NUNCA teria Lead status']:<18d} | {sum(base.values())}")


if __name__ == '__main__':
    sys.exit(main())
