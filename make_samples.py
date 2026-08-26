# -*- coding: utf-8 -*-
"""샘플 데이터 생성기
구매 데이터(purchase.xlsx)와 장비 모델 데이터(model.xlsx)를 생성하고,
대시보드 데모용 임베디드 데이터(js/sample-data.js)를 함께 만든다.

실행: python3 make_samples.py
"""
import json
import os
import random

from openpyxl import Workbook

random.seed(42)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# 톤급 코드 → 모델 접두 숫자 (2X → 20번대 모델명, 100 → 10톤급)
TON_CODES = ["2X", "3X", "4X", "5X", "6X", "7X", "8X", "100", "120", "140", "160", "180"]

VENDORS = ["대한정공", "한빛산업", "세명테크", "우주금속", "동성부품",
           "미래정밀", "삼호기계", "글로벌파츠", "성일단조"]

PART_CATEGORIES = ["붐 실린더", "버킷 링크", "유압호스", "선회베어링", "트랙롤러",
                   "아이들러", "스프로킷", "카운터웨이트", "메인펌프 부품", "라디에이터",
                   "에어클리너", "조인트", "씰킷", "핀 세트", "부싱"]


def ton_number(code):
    if code.endswith("X"):
        return int(code[:-1])
    return int(code) // 10


def make_models():
    """톤급 코드별 모델 1~3개 생성 (예: 25D-9, 30L-7)"""
    models = []
    suffixes = ["D-9", "L-7", "NX-3", "S-9V", "E-10"]
    for code in TON_CODES:
        n = random.randint(1, 3)
        base = ton_number(code) * 10
        used = set()
        for _ in range(n):
            while True:
                num = base + random.choice([0, 2, 5, 7, 8])
                sfx = random.choice(suffixes)
                name = f"{num}{sfx}"
                if name not in used:
                    used.add(name)
                    break
            models.append({"model": name, "ton_code": code})
    return models


def main():
    models = make_models()

    parts = []          # (품번, [모델들])
    purchase_rows = []  # (품번, 업체명, 물량, 금액)
    model_rows = []     # (품번, 모델명, 톤급코드)

    n_parts = 320
    for i in range(n_parts):
        part_no = f"P-{10000 + i}"
        # 품번 1개가 여러 모델에 적용되는 1:N 케이스 약 25%
        k = 1 if random.random() > 0.25 else random.randint(2, 4)
        applied = random.sample(models, k)
        parts.append((part_no, applied))
        for m in applied:
            model_rows.append((part_no, m["model"], m["ton_code"]))

        # 동일 품번 복수 업체 공급 약 35%
        n_vendors = 1 if random.random() > 0.35 else random.randint(2, 3)
        chosen = random.sample(VENDORS, n_vendors)
        # 톤급이 클수록 단가·물량 규모를 키움
        ton = ton_number(applied[0]["ton_code"])
        for v in chosen:
            qty = random.randint(50, 3000)
            unit = random.randint(5, 400) * 1000 * max(1, ton // 4)
            amt = qty * unit
            purchase_rows.append((part_no, v, qty, amt))

    # purchase.xlsx
    wb = Workbook()
    ws = wb.active
    ws.title = "구매데이터"
    ws.append(["품번", "업체명", "연간 구매 물량", "연간 구매 금액"])
    for r in purchase_rows:
        ws.append(list(r))
    wb.save(os.path.join(OUT_DIR, "data", "purchase.xlsx"))

    # model.xlsx
    wb2 = Workbook()
    ws2 = wb2.active
    ws2.title = "모델데이터"
    ws2.append(["품번", "장비 모델명", "톤급 코드"])
    for r in model_rows:
        ws2.append(list(r))
    wb2.save(os.path.join(OUT_DIR, "data", "model.xlsx"))

    # js/sample-data.js (임베디드 데모 데이터)
    payload = {
        "purchase": [
            {"품번": p, "업체명": v, "연간 구매 물량": q, "연간 구매 금액": a}
            for (p, v, q, a) in purchase_rows
        ],
        "model": [
            {"품번": p, "장비 모델명": m, "톤급 코드": c}
            for (p, m, c) in model_rows
        ],
    }
    js = ("// 자동 생성 파일 — make_samples.py 실행으로 갱신됩니다.\n"
          "window.SAMPLE_DATA = "
          + json.dumps(payload, ensure_ascii=False)
          + ";\n")
    with open(os.path.join(OUT_DIR, "js", "sample-data.js"), "w", encoding="utf-8") as f:
        f.write(js)

    print(f"purchase rows: {len(purchase_rows)}, model rows: {len(model_rows)}, parts: {n_parts}")
    print("생성 완료: data/purchase.xlsx, data/model.xlsx, js/sample-data.js")


if __name__ == "__main__":
    main()
