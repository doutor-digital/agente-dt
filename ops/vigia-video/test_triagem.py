"""Testes da lógica pura da triagem (sem ffmpeg). Rodar: python3 -I -m unittest ops/vigia-video/test_triagem.py -v
(ou: cd ops/vigia-video && python3 -I test_triagem.py)"""
import importlib.util
import os
import random
import unittest
from datetime import datetime

_aqui = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("triagem", os.path.join(_aqui, "triagem.py"))
triagem = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(triagem)


def serie(valores):
    return [(float(i), v) for i, v in enumerate(valores)]


class LimiarAuto(unittest.TestCase):
    def test_camera_ruidosa_com_movimento_raro_fica_acima_do_ruido(self):
        # 97% ruído disperso em torno de 0,01 e 3% de movimento forte: o limiar tem de ficar ACIMA de todo o ruído
        rnd = random.Random(7)
        ruido = [rnd.uniform(0.005, 0.015) for _ in range(970)]
        mov = [0.2] * 30
        lim = triagem.limiar_auto(serie(ruido + mov))
        self.assertGreater(lim, max(ruido), lim)
        self.assertLess(lim, 0.2)

    def test_movimento_domina_e_o_ruido_nao_existe_limiar_fica_abaixo_dele(self):
        # vídeo limpo ou --rapido: os valores não nulos são quase todos o próprio movimento (achado no teste sintético)
        valores = [0.1464] * 40 + [0.0732] * 2 + [0.0001] * 3
        lim = triagem.limiar_auto(serie(valores))
        self.assertLessEqual(lim, 0.0732 + 1e-9)
        self.assertGreater(lim, 0.0001)
        self.assertEqual(len(triagem.agrupar(serie([0.0] * 10 + valores[:5] + [0.0] * 30), lim, 20, 5)), 1)

    def test_camera_muito_quieta_usa_o_piso(self):
        lim = triagem.limiar_auto(serie([0.0001] * 100))
        self.assertTrue(0.004 <= lim < 0.01, lim)

    def test_sem_nenhuma_nota_nao_quebra(self):
        self.assertEqual(triagem.limiar_auto(serie([0.0] * 50)), 0.01)
        self.assertEqual(triagem.limiar_auto([]), 0.01)


class Agrupar(unittest.TestCase):
    def test_junta_pausas_curtas_e_separa_as_longas(self):
        notas =[(float(t), 0.5 if (10 <= t < 20 or 30 <= t < 35 or 80 <= t < 90) else 0.0) for t in range(100)]
        ev = triagem.agrupar(notas, 0.1, 20, 5)
        self.assertEqual(len(ev), 2)  # 10-35 juntos (pausa de 10 s < 20); 80-90 separado
        self.assertEqual((ev[0]["inicio"], ev[0]["fim"]), (5.0, 39.0))
        self.assertEqual(ev[1]["inicio"], 75.0)


class MovimentoPorHora(unittest.TestCase):
    def test_hora_do_relogio_atravessando_a_meia_noite(self):
        base = datetime(2026, 11, 3, 23, 30, 0)
        notas = [(float(t), 0.5) for t in (10, 11, 12, 1900, 1901)]  # 23:30:10.. e 00:01:40 do dia seguinte
        out = triagem.movimento_por_hora(notas, 0.1, 3 * 3600, base)
        por = {h["hora"]: h["segundos"] for h in out}
        self.assertEqual(por["2026-11-03T23:00"], 3)
        self.assertEqual(por["2026-11-04T00:00"], 2)
        self.assertEqual(por["2026-11-04T01:00"], 0)
        self.assertEqual(out[0]["hora"], "2026-11-03T23:00")

    def test_sem_hora_real_usa_a_hora_do_video(self):
        out = triagem.movimento_por_hora([(5.0, 0.5), (3700.0, 0.5)], 0.1, 7300, None)
        self.assertEqual([h["segundos"] for h in out], [1, 1, 0])
        self.assertTrue(out[0]["hora"].startswith("video+"))


if __name__ == "__main__":
    unittest.main()
