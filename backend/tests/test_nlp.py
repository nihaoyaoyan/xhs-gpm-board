from app.services.nlp.local import LocalAnalyzer, extract_keywords, local_sentiment


def test_local_sentiment_positive_and_negative():
    sentiment, score = local_sentiment("虾仁非常新鲜，包装很好，很满意，下次还买")
    assert sentiment == "positive"
    assert score >= 0.66

    sentiment, score = local_sentiment("太差了，冰袋全化了，很失望，不会再来")
    assert sentiment == "negative"
    assert score <= 0.33


def test_extract_keywords_returns_food_terms():
    keywords = extract_keywords("虾仁个头均匀，解冻后没有缩水，炒蛋很鲜")
    assert keywords
    assert all(len(word) >= 2 for word in keywords)
    assert len(keywords) <= 5


async def test_local_analyzer_batch():
    analyzer = LocalAnalyzer()
    texts = ["三文鱼很新鲜，油脂漂亮", "包装破损，体验很差"]
    results = await analyzer.analyze_batch(texts)
    assert len(results) == 2
    assert all(result.analyzer_type == "local" for result in results)
    assert results[0].sentiment in {"positive", "neutral", "negative"}
    assert results[1].sentiment == "negative"
    assert all(0.0 <= result.score <= 1.0 for result in results)
