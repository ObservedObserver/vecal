import { VectorDB } from './index';

interface HNStory {
  id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
}

const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const saveKeyBtn = document.getElementById('saveKey') as HTMLButtonElement;
const loadBtn = document.getElementById('loadStories') as HTMLButtonElement;
const searchInput = document.getElementById('searchInput') as HTMLInputElement;
const searchBtn = document.getElementById('searchBtn') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;
const resultsList = document.getElementById('results') as HTMLUListElement;

let db: VectorDB | null = null;
let dimension = 0;

function setStatus(msg: string) {
  statusDiv.textContent = msg;
}

function loadStoredKey() {
  const k = localStorage.getItem('openaiKey') || '';
  apiKeyInput.value = k;
}

loadStoredKey();

saveKeyBtn.onclick = () => {
  localStorage.setItem('openaiKey', apiKeyInput.value.trim());
  setStatus('API key saved');
};

async function fetchEmbedding(text: string, key: string): Promise<Float32Array> {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  const json = await res.json();
  const emb: number[] = json.data[0].embedding;
  return Float32Array.from(emb);
}

async function fetchTopStories(): Promise<HNStory[]> {
  const idsRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
  const ids: number[] = await idsRes.json();
  const top = ids.slice(0, 30);
  const stories: HNStory[] = [];
  for (const id of top) {
    const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    stories.push(await r.json());
  }
  return stories;
}

loadBtn.onclick = async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus('Please enter API key');
    return;
  }
  setStatus('Loading stories...');
  if (db) {
    await db.close();
    indexedDB.deleteDatabase('hn-stories');
  }
  db = null;
  const stories = await fetchTopStories();
  for (const story of stories) {
    const vec = await fetchEmbedding(story.title, key);
    if (!db) {
      dimension = vec.length;
      db = new VectorDB({ dbName: 'hn-stories', dimension });
    }
    await db.add(vec, { title: story.title, url: story.url || `https://news.ycombinator.com/item?id=${story.id}` });
  }
  setStatus(`Indexed ${stories.length} stories`);
};

searchBtn.onclick = async () => {
  if (!db) {
    setStatus('Load stories first');
    return;
  }
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatus('Please enter API key');
    return;
  }
  const query = searchInput.value;
  if (!query) return;
  const vec = await fetchEmbedding(query, key);
  const results = await db.search(vec, 5);
  resultsList.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = r.metadata?.url || '#';
    a.textContent = r.metadata?.title || r.id;
    a.target = '_blank';
    li.appendChild(a);
    li.appendChild(document.createTextNode(` (score: ${r.score.toFixed(2)})`));
    resultsList.appendChild(li);
  }
};
