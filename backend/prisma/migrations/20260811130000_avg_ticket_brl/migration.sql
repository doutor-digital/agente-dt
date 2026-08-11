-- Ticket médio (R$) por unidade — alimenta o card "Receita × Custo" do dashboard.
-- Aditiva e nullable: unidades existentes ficam com NULL (não configurado) e o
-- front pede pra preencher em vez de inventar receita.
ALTER TABLE "units" ADD COLUMN "avg_ticket_brl" DECIMAL(10,2);
