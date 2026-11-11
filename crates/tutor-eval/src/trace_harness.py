#!/usr/bin/env python3
"""Harness honesto de traçado passo-a-passo (estilo "Python Tutor").

Corre o programa do aluno sob ``sys.settrace`` e produz um TRAÇO REAL da
execução: cada passo é uma linha/call/return efectivamente executada, com as
variáveis locais do frame do aluno (nome, repr truncado, type().__name__), a
profundidade da pilha e o comprimento do stdout acumulado até ali. Nada é
inventado — se o programa falhar, a mensagem vai no JSON; se exceder o tecto de
passos, pára e assinala a truncagem.

Uso: ``python3 trace_harness.py <ficheiro-do-aluno>``

Emite para o **stdout real** (guardado antes de redireccionar) um único objecto
JSON:  ``{"steps": [...], "stdout": "...", "error"?: "...", "truncated"?: N}``.
O stdout do programa do aluno é capturado à parte (redirecção de ``sys.stdout``),
nunca contaminando o JSON.
"""

import io
import json
import sys
import traceback

# Tecto de passos: ao exceder, abortamos a execução (excepção interna) e
# assinalamos a truncagem, em vez de deixar um ciclo correr até ao timeout.
MAX_STEPS = 2000

# Comprimento máximo do repr de cada variável local.
REPR_TRUNC = 80


class _StepLimit(Exception):
    """Sinal interno: atingiu-se MAX_STEPS; aborta a execução ordenadamente."""


def _safe_repr(value):
    """repr() defensivo e truncado — nunca rebenta, nunca devolve algo enorme."""
    try:
        text = repr(value)
    except Exception:  # noqa: BLE001 - repr do aluno pode levantar qualquer coisa
        text = "<unrepresentable>"
    if len(text) > REPR_TRUNC:
        text = text[:REPR_TRUNC] + "..."
    return text


def _type_name(value):
    try:
        return type(value).__name__
    except Exception:  # noqa: BLE001
        return "?"


def main():
    if len(sys.argv) < 2:
        json.dump({"steps": [], "stdout": "", "error": "no student file given"},
                  sys.stdout)
        return

    student_file = sys.argv[1]
    with open(student_file, "r", encoding="utf-8") as handle:
        source = handle.read()

    steps = []
    state = {"count": 0, "truncated": False}

    # Guardamos o stdout REAL antes de redireccionar: é por aqui que sai o JSON.
    real_stdout = sys.stdout
    captured = io.StringIO()

    def frame_depth(frame):
        """Profundidade = nº de frames-do-aluno acima deste (módulo = 0)."""
        depth = 0
        parent = frame.f_back
        while parent is not None:
            if parent.f_code.co_filename == student_file:
                depth += 1
            parent = parent.f_back
        return depth

    def collect_locals(frame):
        out = []
        # list(...) congela a vista: o dicionário pode mudar durante a iteração.
        for name, value in list(frame.f_locals.items()):
            out.append({
                "name": name,
                "value": _safe_repr(value),
                "ty": _type_name(value),
            })
        return out

    def tracer(frame, event, arg):
        # Só rastreamos o ficheiro do aluno — ignoramos frames internos/harness.
        if frame.f_code.co_filename != student_file:
            return tracer
        if event in ("line", "call", "return"):
            if state["count"] >= MAX_STEPS:
                state["truncated"] = True
                # Abortar a execução de forma ordenada (desliga o trace e
                # propaga até ao exec); evita deixar um ciclo correr até ao
                # timeout de parede.
                raise _StepLimit()
            steps.append({
                "line": frame.f_lineno,
                "event": event,
                "func": frame.f_code.co_name,
                "depth": frame_depth(frame),
                "locals": collect_locals(frame),
                "stdout_len": len(captured.getvalue()),
            })
            state["count"] += 1
        return tracer

    namespace = {"__name__": "__main__", "__file__": student_file}
    error = None

    old_stdout = sys.stdout
    sys.stdout = captured
    sys.settrace(tracer)
    try:
        code_obj = compile(source, student_file, "exec")
        exec(code_obj, namespace)  # noqa: S102 - sandboxed no runner Rust
    except _StepLimit:
        pass  # truncagem já assinalada em state
    except SystemExit:
        pass  # sys.exit() do aluno é um fim normal
    except BaseException:  # noqa: BLE001 - queremos a mensagem, não rebentar
        error = traceback.format_exc(limit=8)
    finally:
        sys.settrace(None)
        sys.stdout = old_stdout

    result = {"steps": steps, "stdout": captured.getvalue()}
    if error is not None:
        result["error"] = error
    if state["truncated"]:
        result["truncated"] = MAX_STEPS

    json.dump(result, real_stdout)


if __name__ == "__main__":
    main()
