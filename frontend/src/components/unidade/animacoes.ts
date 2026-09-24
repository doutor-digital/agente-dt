import { useEffect, useRef, useState } from 'react';

/**
 * Movimento da tela da unidade, num lugar só.
 *
 * Regra que vale pra todos: `prefers-reduced-motion` desliga tudo e entrega o valor
 * final na hora. Animação que não respeita isso não é enfeite, é obstáculo.
 */

export const semMovimento = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Número que sobe até o valor. Não é enfeite: o olho acompanha a subida e a
 * ordem de grandeza gruda — 376 contando é mais lembrado que 376 parado.
 */
export function useContagem(alvo: number, ms = 900): number {
  const [n, setN] = useState(() => (semMovimento() ? alvo : 0));
  const anterior = useRef(alvo);

  useEffect(() => {
    if (semMovimento()) {
      setN(alvo);
      anterior.current = alvo;
      return;
    }
    const de = anterior.current === alvo ? 0 : anterior.current;
    anterior.current = alvo;
    const inicio = performance.now();
    let vivo = true;

    const passo = (agora: number) => {
      if (!vivo) return;
      const t = Math.min(1, (agora - inicio) / ms);
      // desacelera no fim: chega no número e para, sem quicar
      const suave = 1 - Math.pow(1 - t, 3);
      setN(Math.round(de + (alvo - de) * suave));
      if (t < 1) requestAnimationFrame(passo);
    };
    const id = requestAnimationFrame(passo);
    return () => {
      vivo = false;
      cancelAnimationFrame(id);
    };
  }, [alvo, ms]);

  return n;
}

/** Entra quando aparece na tela. Evita animar o que ninguém está olhando. */
export function useAoAparecer<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [visivel, setVisivel] = useState(semMovimento());

  useEffect(() => {
    if (semMovimento() || !ref.current) {
      setVisivel(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => e.isIntersecting && setVisivel(true),
      { threshold: 0.15 },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, []);

  return { ref, visivel };
}
