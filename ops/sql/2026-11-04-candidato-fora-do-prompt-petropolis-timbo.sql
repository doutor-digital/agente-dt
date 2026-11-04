-- 04/11/2026 — a regra de CANDIDATO A VAGA agora é GLOBAL (prompt-composer, bloco <nao_paciente> + ferramenta marcar_nao_paciente).
-- Este script tira o item "- Candidato a vaga: ..." da seção "QUEM NÃO É PACIENTE" do system_prompt de Petrópolis e Timbó,
-- para o texto da unidade não mandar `pausar_ia` por cima da regra nova. Funcionário, fornecedor, propaganda e agradecimento
-- ficam como estão. Rode DEPOIS do deploy do PR (antes dele, a unidade ficaria sem regra de candidato nenhuma).
--
-- Como rodar (sem `-i` dentro de `bash -s`; mande o arquivo e redirecione):
--   scp este.sql root@89.116.214.130:/tmp/ && ssh root@89.116.214.130 \
--     'C=$(docker ps -qf name=ddagentdb_db | head -1); docker exec -i "$C" psql -U agente -d agente_dt -v ON_ERROR_STOP=1 < /tmp/2026-11-04-candidato-fora-do-prompt-petropolis-timbo.sql'
--
-- Para desfazer: o texto inteiro de antes está em backup_system_prompt_20261104 (create table abaixo):
--   update units u set system_prompt = b.system_prompt from backup_system_prompt_20261104 b where b.unit_id = u.id;
begin;

-- 1) Backup do texto completo (uma linha por unidade). Falha se a tabela já existe: não sobrescreve backup antigo.
create table backup_system_prompt_20261104 as
  select id as unit_id, slug, system_prompt, now() as salvo_em
  from units
  where slug in ('doutor-hernia-petropolis', 'doutor-hernia-timbo');

-- 2) Mede o antes: quantas linhas "- Candidato a vaga:" cada unidade tem (tem que ser 1).
select slug,
       length(system_prompt) as tamanho_antes,
       (select count(*) from regexp_matches(system_prompt, '^- Candidato a vaga:[^\n]*\n', 'gn')) as linhas_candidato
from units
where slug in ('doutor-hernia-petropolis', 'doutor-hernia-timbo');

-- 3) Tira a linha. O bloco DO confere o resultado e aborta (rollback do backup também) se não for exatamente 1 linha por unidade.
do $$
declare
  r record;
  depois text;
begin
  for r in select id, slug, system_prompt from units where slug in ('doutor-hernia-petropolis', 'doutor-hernia-timbo') loop
    depois := regexp_replace(r.system_prompt, '^- Candidato a vaga:[^\n]*\n', '', 'n');
    if length(r.system_prompt) = length(depois) then
      raise exception '% : não achei a linha "- Candidato a vaga:" (o texto do banco mudou?) — nada foi alterado', r.slug;
    end if;
    if depois ~ '- Candidato a vaga:' then
      raise exception '% : sobrou outra linha de candidato — confira à mão antes de rodar', r.slug;
    end if;
    update units set system_prompt = depois where id = r.id;
    insert into unit_change_log (id, unit_id, category, summary, details, author, created_at)
    values (gen_random_uuid()::text, r.id, 'config',
            'Tirei o item "Candidato a vaga" do prompt: a regra agora é global (marcar_nao_paciente)',
            'Backup completo em backup_system_prompt_20261104. Removidos '|| (length(r.system_prompt) - length(depois)) ||' caracteres.',
            'claude (pedido do João, 04/11/2026)', now());
  end loop;
end $$;

-- 4) Prova: a linha sumiu, o resto da seção ficou.
select slug,
       length(system_prompt) as tamanho_depois,
       (system_prompt ~ '- Candidato a vaga:') as ainda_tem_candidato,
       (system_prompt ~ '- Funcionário da clínica') as manteve_funcionario,
       (system_prompt ~ '- Fornecedor ou agência') as manteve_fornecedor
from units
where slug in ('doutor-hernia-petropolis', 'doutor-hernia-timbo');

commit;
