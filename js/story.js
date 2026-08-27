let storyIndex=0,storyItems=[],storyTimer=null;
function openHighlightView(index){
 storyItems=getHighlights(); storyIndex=index; showStory();
}
function showStory(){
 clearTimeout(storyTimer); let item=storyItems[storyIndex]; if(!item)return;
 let old=document.getElementById('storyViewer'); if(old)old.remove();
 let v=document.createElement('div');v.id='storyViewer';v.className='story-overlay';
 v.innerHTML=`<div class="story-card">
 <div class="story-top"><div class="story-bars">${storyItems.map((x,i)=>`<span class="${i<=storyIndex?'active':''}"></span>`).join('')}</div><div class="story-head"><b>@${currentProfile.username}</b></div></div>
 <div class="story-actions"><button id="storyClose">×</button><button id="storyMore">⋯</button></div>
 ${item.type==='video'?`<video id="storyMedia" src="${item.image}" autoplay></video>`:`<img src="${item.image}">`}
 <div class="story-bottom"><div class="story-reply">Yanıt ver...</div><button>♡</button><button>↗</button></div></div>`;
 document.body.appendChild(v);
 document.getElementById('storyClose').onclick=()=>v.remove();
 document.getElementById('storyMore').onclick=()=>alert('Öne çıkan seçenekleri');
 let media=document.getElementById('storyMedia');
 if(media)media.onended=nextStory; else storyTimer=setTimeout(nextStory,5000);
 v.onclick=e=>{if(e.target===v)v.remove()};
 v.onpointerdown=e=>{v.dataset.x=e.clientX};
 v.onpointerup=e=>{let d=e.clientX-v.dataset.x;if(d>60)prevStory();if(d<-60)nextStory()};
}
function nextStory(){storyIndex++; if(storyIndex>=storyItems.length)storyIndex=0; showStory()}
function prevStory(){storyIndex--; if(storyIndex<0)storyIndex=storyItems.length-1; showStory()}
