from prism.rules.engine import evaluate
from prism.stages.retrieve import Retriever, rrf
from tests.factories import make_sheet


def test_rrf_prefers_items_ranked_high_in_both():
    # "b" is 2nd and 1st, "a" is 1st and 2nd: tied scores, broken by id; both beat c/d.
    assert rrf([["a", "b", "c"], ["b", "a", "d"]])[:2] == ["a", "b"]
    # "b" appears near the top of both rankings and outranks items present in only one.
    assert rrf([["a", "b", "c"], ["d", "b", "e"]])[0] == "b"
    assert rrf([["x"], ["y", "x"]])[0] == "x"


def test_pack_contains_rule_and_application_evidence(kb):
    sheet = make_sheet(matrix="powder", targets=("API concentration",), domain="pharma")
    pack = Retriever(kb).pack(sheet, evaluate(sheet, kb))
    ids = pack.ids()
    assert {"S01-p14-blend-potency", "S01-p10-nir-range", "TABLE-nir_diffuse_reflection_probe"} <= ids
    assert pack.reasons["S01-p10-nir-range"].startswith("method range")


def test_pack_respects_cap_and_skips_business_cards(kb):
    sheet = make_sheet(matrix="liquid", targets=("water content",))
    pack = Retriever(kb).pack(sheet, evaluate(sheet, kb), max_cards=15)
    assert len(pack.cards) <= 15
    assert all(c.scope.value != "business_context" for c in pack.cards
               if pack.reasons.get(c.id, "").startswith("search"))


def test_dense_ranking_used_when_embeddings_available(kb, tmp_path):
    class Gw:
        def embed(self, texts):
            return [[1.0, float(i % 7)] for i, _ in enumerate(texts)]
    r = Retriever(kb, Gw(), index_dir=tmp_path)
    assert r.search("NIR reflection dairy", k=5)
    assert any(tmp_path.iterdir())


def test_dense_index_falls_back_to_memory_when_dir_unwritable(kb, tmp_path):
    class Gw:
        def embed(self, texts):
            return [[1.0, float(i % 7)] for i, _ in enumerate(texts)]
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    r = Retriever(kb, Gw(), index_dir=blocker / "index")
    assert r.search("NIR reflection dairy", k=5)
    assert r._vectors is not None


def test_index_dir_from_environment(kb, tmp_path, monkeypatch):
    monkeypatch.setenv("PRISM_INDEX_DIR", str(tmp_path / "idx"))
    assert Retriever(kb).index_dir == tmp_path / "idx"


def test_each_embedder_keeps_its_own_index_and_a_size_mismatch_falls_back_to_bm25(kb, tmp_path):
    from types import SimpleNamespace

    def gateway(profile, dims):
        roles = {"embedder": SimpleNamespace(models=[f"{profile}-embed"])}
        return SimpleNamespace(profile=SimpleNamespace(name=profile, roles=roles),
                               embed=lambda texts: [[1.0] * dims for _ in texts])

    Retriever(kb, gateway("gwdg", 4), tmp_path).search("NIR fiber")
    hits = Retriever(kb, gateway("gemini", 6), tmp_path).search("NIR fiber")       # no reuse of the 4-dim index
    assert hits and len(list(tmp_path.glob("*.npy"))) == 2
    r = Retriever(kb, gateway("gemini", 6), tmp_path)
    r.gateway = SimpleNamespace(profile=r.gateway.profile, embed=lambda texts: [[1.0] * 5 for _ in texts])
    assert r.search("NIR fiber")                                                    # BM25 only, no crash
