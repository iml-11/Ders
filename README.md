# 📚 Ders Asistanı

Ders notlarını yükle, **istediğin yapay zeka API'siyle** dersi sana anlatsın.

- 🎓 **Anlatım** – Notlarını bir öğretmen gibi bölüm bölüm, örneklerle anlatır
- 📝 **Özet** – Sınav öncesi tekrar için yoğun özet, kavram tablosu, formüller
- ✅ **Test** – Çoktan seçmeli, açıklamalı test üretir; puanını gösterir, yanlışlarını tekrar anlatır
- 🃏 **Bilgi kartları** – Çevrilebilir flashcard'lar (klavye: ← → boşluk)
- 💬 **Soru sor** – Notlarını bilen bir yapay zekayla sohbet
- 📄 PDF, Word (.docx), TXT/MD ve **not fotoğrafları** desteklenir (taranmış PDF'ler görsel olarak gönderilir)
- ➗ Matematik formülleri (LaTeX) düzgün görünür
- 🌓 Açık/koyu tema, mobil uyumlu
- 💾 Dersler tarayıcında saklanır; JSON olarak yedekleyip geri yükleyebilirsin

## Desteklenen yapay zekalar

| Sağlayıcı | Anahtar nereden alınır |
|---|---|
| Google Gemini (ücretsiz katman var) | https://aistudio.google.com/apikey |
| OpenAI (ChatGPT) | https://platform.openai.com/api-keys |
| Anthropic (Claude) | https://console.anthropic.com |
| OpenRouter (tek anahtarla yüzlerce model) | https://openrouter.ai/keys |
| Groq | https://console.groq.com/keys |
| DeepSeek | https://platform.deepseek.com |
| Mistral | https://console.mistral.ai |
| Ollama (bilgisayarında, ücretsiz, anahtarsız) | https://ollama.com |
| Özel – OpenAI uyumlu herhangi bir API (LM Studio, Together, vb.) | – |

Model adını serbestçe yazabilirsin; listedekiler sadece öneridir.

## Nasıl çalıştırılır?

Kurulum gerekmez, tamamen statik bir sitedir.

**En kolayı – GitHub Pages:**
1. Repo → **Settings → Pages**
2. *Source*: `Deploy from a branch`, branch'i seç, klasör `/ (root)` → **Save**
3. Birkaç dakika sonra `https://<kullanıcı-adın>.github.io/<repo-adı>/` adresinden kullan.

**Bilgisayarında:**
```bash
python3 -m http.server 8000
# tarayıcıda http://localhost:8000 aç
```
(`index.html`'i çift tıklayarak açmak da çoğu tarayıcıda çalışır.)

## Kullanım

1. Sağ üstteki **⚙️** simgesine tıkla → sağlayıcıyı seç, API anahtarını yapıştır, modeli seç → **Bağlantıyı test et** → **Kaydet**
2. **＋ Yeni Ders** → notlarını sürükle bırak veya yapıştır → **Dersi oluştur**
3. Anlatım otomatik başlar. Diğer sekmelerden özet, test, kart oluştur ve soru sor.

### Ollama ile ücretsiz/yerel kullanım
Tarayıcının Ollama'ya bağlanabilmesi için Ollama'yı şöyle başlat:
```bash
OLLAMA_ORIGINS="*" ollama serve
```
Sonra ayarlardan **Ollama**'yı seç ve yüklü bir model adı yaz (örn. `llama3.1`).

## Gizlilik

- API anahtarın **yalnızca kendi tarayıcında** (localStorage) saklanır ve doğrudan seçtiğin sağlayıcıya gönderilir. Arada başka sunucu yoktur.
- Notların ve derslerin tarayıcının IndexedDB deposunda durur. Tarayıcı verilerini silersen kaybolur – **⬇ Yedekle** ile yedek al.
- Siteyi başkalarıyla paylaşırsan herkes kendi anahtarını girer; senin anahtarın paylaşılmaz.

## Dosya yapısı

```
index.html        Arayüz
css/style.css     Tasarım (açık/koyu tema)
js/providers.js   Yapay zeka sağlayıcıları ve akışlı (streaming) API çağrıları
js/files.js       PDF / DOCX / metin / görsel okuma
js/app.js         Uygulama mantığı (dersler, anlatım, test, kartlar, sohbet)
```

Yeni bir sağlayıcı eklemek için `js/providers.js` içindeki `PROVIDERS` listesine OpenAI uyumlu bir kayıt eklemen yeterli.
