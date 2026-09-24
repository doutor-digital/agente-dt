/**
 * O CSS da tela da unidade. Fica fora do componente porque é grande e porque
 * escopo importa: tudo vive sob `.tela-unidade`, então o console do operador
 * (que é Inter, zinco e outra pegada) não é tocado.
 */
export const ESTILOS = `
.tela-unidade{
  --noite:#070D18; --placa:#0E1728; --linha:rgba(255,255,255,.08);
  --osso:#EAF0F9; --bruma:#7E93B4;
  --vida:#4C9EFF; --carne:#2FBF71; --alerta:#FF6B3D;
  background:
    radial-gradient(1100px 520px at 12% -12%, rgba(76,158,255,.13), transparent 62%),
    radial-gradient(760px 420px at 96% 4%, rgba(47,191,113,.08), transparent 60%),
    var(--noite);
  color:var(--osso);
  font-family:"Public Sans", system-ui, sans-serif;
  min-height:100vh;
}
.tela-unidade .font-display{
  font-family:"Bricolage Grotesque", system-ui, sans-serif; letter-spacing:-.025em;
}

/* cartão: leve relevo e um fio de luz no topo, pra não ficar chapado */
.tela-unidade .cartao{
  position:relative; overflow:hidden; border-radius:16px;
  border:1px solid var(--linha);
  background:linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.018));
  transition: transform .25s cubic-bezier(.16,1,.3,1), border-color .25s, box-shadow .25s;
}
.tela-unidade .cartao::before{
  content:""; position:absolute; inset:0 0 auto; height:1px;
  background:linear-gradient(90deg, transparent, rgba(255,255,255,.2), transparent);
}
.tela-unidade .cartao.viva:hover{
  transform:translateY(-2px);
  border-color:rgba(76,158,255,.35);
  box-shadow:0 10px 34px -18px rgba(76,158,255,.55);
}

/* entrada em cascata */
.tela-unidade .entra{ opacity:0; transform:translateY(14px); }
.tela-unidade .entra.dentro{ animation: entra .62s cubic-bezier(.16,1,.3,1) forwards; }
@keyframes entra{ to{ opacity:1; transform:none; } }

/* a fita do funil desenha da esquerda pra direita */
.tela-unidade .fita{ transform-origin:left center; animation: desenha 1.1s cubic-bezier(.16,1,.3,1) both; }
@keyframes desenha{ from{ transform:scaleX(.02); opacity:.2 } to{ transform:none; opacity:1 } }

/* barras de hora crescendo do chão */
.tela-unidade .barra{ transform-origin:bottom; animation: cresce .55s cubic-bezier(.16,1,.3,1) both; }
@keyframes cresce{ from{ transform:scaleY(0) } to{ transform:scaleY(1) } }

/* brilho que atravessa o cartão de dinheiro uma vez, pra puxar o olho */
.tela-unidade .brilho::after{
  content:""; position:absolute; inset:0;
  background:linear-gradient(105deg, transparent 38%, rgba(255,255,255,.1) 50%, transparent 62%);
  transform:translateX(-120%); animation: varre 2.6s ease-in-out .7s 2;
}
@keyframes varre{ to{ transform:translateX(120%) } }

/* linha de conversa e itens de lista */
.tela-unidade .toque{ transition: background .18s, color .18s; }
.tela-unidade .toque:hover{ background:rgba(255,255,255,.045); }

/* esqueleto enquanto carrega */
.tela-unidade .osso{
  background:linear-gradient(90deg, rgba(255,255,255,.05) 25%, rgba(255,255,255,.1) 37%, rgba(255,255,255,.05) 63%);
  background-size:400% 100%; animation: brilha 1.5s ease infinite; border-radius:10px;
}
@keyframes brilha{ from{ background-position:100% 0 } to{ background-position:-100% 0 } }

@media (prefers-reduced-motion: reduce){
  .tela-unidade .entra, .tela-unidade .entra.dentro,
  .tela-unidade .fita, .tela-unidade .barra,
  .tela-unidade .brilho::after, .tela-unidade .osso{
    animation:none !important; opacity:1 !important; transform:none !important;
  }
  .tela-unidade .cartao.viva:hover{ transform:none; }
}
`;
