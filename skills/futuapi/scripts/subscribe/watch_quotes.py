#!/usr/bin/env python3
"""
持续订阅报价推送。

从 stdin 读取一行 JSON：{"codes": ["HK.00700", "SH.600519"]}
每收到一次报价，向 stdout 写一行 JSON：{"type":"quote","code":"HK.00700","lastPrice":417.4}

连接保持打开。代码列表变化时只调整订阅；取消订阅至少等 60 秒，满足富途接口限制。
OpenD 断开后会重试，不退出。
"""
import json
import math
import os
import signal
import sys
import threading
import time

import logging

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def emit_quotes(data):
    if data is None:
        return
    try:
        size = len(data)
    except TypeError:
        return
    for index in range(size):
        row = data.iloc[index] if hasattr(data, "iloc") else data[index]
        getter = getattr(row, "get", None)
        if getter is None:
            continue
        code = getter("code")
        try:
            price = float(getter("last_price"))
        except (TypeError, ValueError):
            continue
        if not code or not math.isfinite(price) or price <= 0:
            continue
        emit({"type": "quote", "code": str(code), "lastPrice": price})


class QuoteHandler:
    """延迟绑定 futu 的回调，方便在导入失败时仍能输出 JSON 错误。"""

    def __init__(self, base):
        self._base = base

    def __call__(self):
        handler_cls = self._base

        class _Handler(handler_cls):
            def on_recv_rsp(self, rsp_pb):
                from futu import RET_OK, RET_ERROR
                ret_code, data = super().on_recv_rsp(rsp_pb)
                if ret_code != RET_OK:
                    emit({"type": "error", "message": str(data)})
                    return RET_ERROR, data
                emit_quotes(data)
                return RET_OK, data

        return _Handler()


def main():
    host = os.getenv("FUTU_OPEND_HOST", "127.0.0.1")
    port = int(os.getenv("FUTU_OPEND_PORT", "11111"))
    desired = set()
    desired_lock = threading.Lock()
    stop = threading.Event()

    def read_stdin():
        for line in sys.stdin:
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                continue
            codes = payload.get("codes")
            if not isinstance(codes, list):
                continue
            with desired_lock:
                desired.clear()
                desired.update(str(code).strip() for code in codes if str(code).strip())
        stop.set()

    def request_stop(_signum, _frame):
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    threading.Thread(target=read_stdin, daemon=True).start()

    try:
        from futu import OpenQuoteContext, StockQuoteHandlerBase, SubType, RET_OK
    except ImportError as error:
        emit({"type": "error", "message": f"futu-api 未安装：{error}"})
        sys.exit(1)

    handler = QuoteHandler(StockQuoteHandlerBase)()
    while not stop.is_set():
        ctx = None
        subscribed = {}
        reported = None
        try:
            try:
                ctx = OpenQuoteContext(host=host, port=port, ai_type=1)
            except TypeError:
                ctx = OpenQuoteContext(host=host, port=port)
            ctx.set_handler(handler)
            emit({"type": "ready"})
            while not stop.is_set():
                with desired_lock:
                    want = set(desired)
                now = time.monotonic()
                to_add = sorted(code for code in want if code not in subscribed)
                to_drop = sorted(
                    code for code, subscribed_at in subscribed.items()
                    if code not in want and now - subscribed_at >= 60
                )
                if to_add:
                    ret, message = ctx.subscribe(to_add, [SubType.QUOTE], subscribe_push=True)
                    if ret != RET_OK:
                        emit({"type": "error", "message": f"订阅失败：{message}"})
                        stop.wait(15)
                        continue
                    for code in to_add:
                        subscribed[code] = now
                    ret, data = ctx.get_stock_quote(to_add)
                    if ret == RET_OK:
                        emit_quotes(data)
                    else:
                        emit({"type": "error", "message": f"读取已订阅报价失败：{data}"})
                if to_drop:
                    ret, message = ctx.unsubscribe(to_drop, [SubType.QUOTE])
                    if ret == RET_OK:
                        for code in to_drop:
                            subscribed.pop(code, None)
                    else:
                        emit({"type": "error", "message": f"取消订阅失败：{message}"})
                current = tuple(sorted(subscribed))
                if current != reported:
                    reported = current
                    emit({"type": "subscribed", "codes": list(current)})
                stop.wait(1)
        except Exception as error:
            emit({"type": "error", "message": str(error)})
            stop.wait(5)
        finally:
            if ctx is not None:
                ctx.close()


if __name__ == "__main__":
    main()
