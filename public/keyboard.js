/* DrFX Quant - in-app on-screen keyboard.
   Mobile only (fully disabled on desktop / Windows). Opt-in via Settings -> Keyboard.
   Self-contained: does not depend on the main app script, and is loaded as a
   separate <script> so a problem here can never break the rest of the app. */
(function(){
"use strict";
try{
  function coarse(){try{return !!(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches);}catch(e){return false;}}
  function deviceMobile(){return coarse()||(('ontouchstart' in window)&&((navigator.maxTouchPoints||0)>0));}
  if(!deviceMobile())return; // desktop: no keyboard, no listeners, no window.DQKB

  function userOn(){return localStorage.getItem('dq_kb')==='on';}
  function isTextField(el){
    if(!el||el.nodeType!==1)return false;
    if(el.tagName==='TEXTAREA')return true;
    if(el.tagName==='INPUT'){var ty=(el.getAttribute('type')||'text').toLowerCase();return ['text','search','email','url','tel','password','number',''].indexOf(ty)>=0;}
    return false;
  }
  // Theme-aware palette so the keyboard matches the app (iOS-style light / dark).
  function pal(){
    var light=localStorage.getItem('dq_th')==='light';
    return light
      ? {bg:'#ccd1da',key:'#ffffff',keyC:'#11151c',sp:'#a4acb9',spC:'#11151c',ksh:'0 1px 0 rgba(0,0,0,.26)',acc:'#4285f4',accC:'#ffffff'}
      : {bg:'#0e1219',key:'#2a3140',keyC:'#eef3ff',sp:'#1b2230',spC:'#aab6cc',ksh:'0 1px 0 rgba(0,0,0,.5)',acc:'#3a6cdc',accC:'#ffffff'};
  }
  var EN=[['q','w','e','r','t','y','u','i','o','p'],['a','s','d','f','g','h','j','k','l'],['{shift}','z','x','c','v','b','n','m','{bs}'],['{sym}','{lang}','{space}','.','{enter}']];
  var FA=[['ض','ص','ث','ق','ف','غ','ع','ه','خ','ح','ج','چ'],['ش','س','ی','ب','ل','ا','ت','ن','م','ک','گ'],['ظ','ط','ز','ر','ذ','د','پ','و','ژ','{bs}'],['{sym}','{lang}','{space}','،','{enter}']];
  var SYM=[['1','2','3','4','5','6','7','8','9','0'],['@','#','$','_','&','-','+','(',')','/'],['{sym2}','*','"',"'",':',';','!','?','{bs}'],['{abc}','{lang}','{space}','.','{enter}']];
  var SYM2=[['~','`','|','•','√','π','÷','×','¶','∆'],['£','€','¥','^','=','{','}','[',']','%'],['{sym}','©','®','™','§','<','>','°','…','{bs}'],['{abc}','{lang}','{space}','.','{enter}']];
  var st={lay:'en',alpha:'en',shift:false,cur:null};
  function curLayout(){return st.lay==='fa'?FA:st.lay==='sym'?SYM:st.lay==='sym2'?SYM2:EN;}

  // ── Native-keyboard suppression ──────────────────────────────────────────
  // The native keyboard must be suppressed BEFORE a field receives focus,
  // otherwise iOS/Android already commit to showing it and you get BOTH
  // keyboards at once. We set inputmode="none" pre-emptively: on every field as
  // it enters the DOM (observer), and again on pointerdown before focus.
  function suppress(el){try{if(!isTextField(el))return;if(el.dataset.kbIm==null){el.dataset.kbIm=el.getAttribute('inputmode')||'_n_';}el.setAttribute('inputmode','none');}catch(_){}}
  function restoreField(el){
    if(!el||!el.dataset)return;
    try{if(el.dataset.kbIm!=null){if(el.dataset.kbIm==='_n_')el.removeAttribute('inputmode');else el.setAttribute('inputmode',el.dataset.kbIm);delete el.dataset.kbIm;}}catch(_){}
  }
  function allFields(){try{return document.querySelectorAll('input,textarea');}catch(_){return [];}}
  function sweepSuppress(){var f=allFields();for(var i=0;i<f.length;i++)suppress(f[i]);}
  function restoreAll(){var f=allFields();for(var i=0;i<f.length;i++)restoreField(f[i]);}

  function ensureCss(){
    if(document.getElementById('dqkb-css'))return;
    var s=document.createElement('style');s.id='dqkb-css';
    s.textContent='html.dqkb-open .lg-scroll{height:calc(var(--vh,1vh)*100 - var(--dqkb,0px))!important}'
      +'#dq-kb{animation:dqkbUp .18s ease;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}'
      +'#dq-kb *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}'
      +'#dq-kb button{touch-action:none}'
      +'@keyframes dqkbUp{from{transform:translateY(100%)}to{transform:translateY(0)}}'
      +'#dq-kb button:active{filter:brightness(.86)}';
    document.head.appendChild(s);
  }
  function getKb(){
    var p=pal();var k=document.getElementById('dq-kb');
    if(!k){
      ensureCss();
      k=document.createElement('div');k.id='dq-kb';
      // Keep focus on the field + stop iOS text-selection while tapping keys.
      k.addEventListener('pointerdown',function(e){e.preventDefault();},{passive:false});
      k.addEventListener('selectstart',function(e){e.preventDefault();});
      k.addEventListener('contextmenu',function(e){e.preventDefault();});
      document.body.appendChild(k);
    }
    k.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:9600;background:'+p.bg+';padding:7px 4px calc(7px + var(--sab,0px));box-shadow:0 -6px 24px rgba(0,0,0,.4);font-family:Outfit,system-ui,sans-serif;-webkit-user-select:none;user-select:none;direction:ltr;touch-action:none';
    return k;
  }
  function lbl(key){
    if(key==='{bs}')return '⌫';
    if(key==='{enter}')return '⏎';
    if(key==='{shift}')return st.shift?'⇪':'⇧';
    if(key==='{space}')return 'space';
    if(key==='{sym}')return '123';
    if(key==='{sym2}')return '#+=';
    if(key==='{abc}')return 'ABC';
    if(key==='{lang}')return st.alpha==='en'?'فا':'EN';
    return (st.shift&&st.lay==='en')?key.toUpperCase():key;
  }
  function render(){
    var k=getKb();var p=pal();k.innerHTML='';
    var wrap=document.createElement('div');wrap.id='dq-kb-rows';wrap.style.cssText='max-width:680px;margin:0 auto';
    var rows=curLayout();var dir=(st.lay==='fa')?'rtl':'ltr';
    rows.forEach(function(row){
      var r=document.createElement('div');r.style.cssText='display:flex;gap:5px;justify-content:center;margin:3px 3px;direction:'+dir;
      row.forEach(function(key){
        var sp=key.charAt(0)==='{';var wide=key==='{space}';var send=key==='{enter}';
        var flex=wide?'5':(sp?'1.55':'1');
        var bg=send?p.acc:(sp?p.sp:p.key);var col=send?p.accC:(sp?p.spC:p.keyC);
        var b=document.createElement('button');b.type='button';
        b.style.cssText='flex:'+flex+';min-width:0;height:46px;border:0;border-radius:7px;background:'+bg+';color:'+col+';font-size:'+(sp?'13px':'19px')+';font-weight:500;font-family:inherit;cursor:pointer;box-shadow:'+p.ksh+';-webkit-tap-highlight-color:transparent;display:flex;align-items:center;justify-content:center;padding:0;touch-action:none';
        b.innerHTML=lbl(key);
        b.addEventListener('pointerdown',function(e){e.preventDefault();e.stopPropagation();press(key);},{passive:false});
        r.appendChild(b);
      });
      wrap.appendChild(r);
    });
    k.appendChild(wrap);
  }
  function tgt(){var c=st.cur;if(c&&document.contains(c)&&isTextField(c))return c;var a=document.activeElement;return isTextField(a)?a:null;}
  function press(key){
    if(key==='{shift}'){st.shift=!st.shift;render();return;}
    if(key==='{sym}'){st.lay='sym';render();return;}
    if(key==='{sym2}'){st.lay='sym2';render();return;}
    if(key==='{abc}'){st.lay=st.alpha;render();return;}
    if(key==='{lang}'){st.alpha=(st.alpha==='en')?'fa':'en';st.lay=st.alpha;st.shift=false;render();return;}
    var t=tgt();if(!t)return;
    if(key==='{space}'){ins(t,' ');return;}
    if(key==='{bs}'){bks(t);return;}
    if(key==='{enter}'){try{t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));}catch(e){}return;}
    var ch=(st.shift&&st.lay==='en')?key.toUpperCase():key;ins(t,ch);
    if(st.shift&&st.lay==='en'){st.shift=false;render();}
  }
  function ins(t,ch){
    try{var s=t.selectionStart,e=t.selectionEnd;
      if(s==null||e==null){t.value+=ch;}
      else{t.value=t.value.slice(0,s)+ch+t.value.slice(e);var p=s+ch.length;try{t.selectionStart=t.selectionEnd=p;}catch(_){}}
    }catch(_){try{t.value+=ch;}catch(__){}}
    fire(t);
  }
  function bks(t){
    try{var s=t.selectionStart,e=t.selectionEnd;
      if(s==null||e==null){t.value=t.value.slice(0,-1);}
      else if(s!==e){t.value=t.value.slice(0,s)+t.value.slice(e);try{t.selectionStart=t.selectionEnd=s;}catch(_){}}
      else if(s>0){t.value=t.value.slice(0,s-1)+t.value.slice(s);try{t.selectionStart=t.selectionEnd=s-1;}catch(_){}}
    }catch(_){try{t.value=t.value.slice(0,-1);}catch(__){}}
    fire(t);
  }
  function fire(t){try{t.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}}
  function show(target){
    if(!userOn())return;st.cur=target;
    var k=getKb();k.style.display='block';render();
    var de=document.documentElement;de.classList.add('dqkb-open');
    requestAnimationFrame(function(){try{
      var h=k.offsetHeight||268;de.style.setProperty('--dqkb',h+'px');
      var mw=document.querySelector('#mw');
      if(mw){mw.style.bottom=h+'px';}
      else if(target&&target.scrollIntoView){try{target.scrollIntoView({block:'center'});}catch(_){}}
    }catch(_){}});
  }
  function hide(){
    var k=document.getElementById('dq-kb');if(k)k.style.display='none';
    var de=document.documentElement;de.classList.remove('dqkb-open');de.style.setProperty('--dqkb','0px');
    var mw=document.querySelector('#mw');if(mw)mw.style.bottom='0px';
  }

  // Public API used by Settings -> Keyboard toggle.
  window.DQKB={
    isDeviceMobile:deviceMobile,
    get on(){return userOn();},
    set on(v){
      localStorage.setItem('dq_kb',v?'on':'off');
      if(!v){restoreAll();hide();}
      else{sweepSuppress();var a=document.activeElement;if(isTextField(a)){suppress(a);show(a);}}
    }
  };

  // Pre-focus suppression: set inputmode="none" the instant the user touches a
  // field (capture phase runs before the browser's focus/keyboard decision).
  function preTouch(e){if(!userOn())return;var el=e.target;if(isTextField(el))suppress(el);}
  document.addEventListener('pointerdown',preTouch,true);
  document.addEventListener('touchstart',preTouch,true);

  // Catch programmatically-focused / freshly-rendered fields (e.g. modal search
  // boxes that get .focus() called on them) so they never trigger the OS keyboard.
  try{
    var mo=new MutationObserver(function(muts){
      if(!userOn())return;
      for(var i=0;i<muts.length;i++){
        var an=muts[i].addedNodes;
        for(var j=0;j<an.length;j++){
          var n=an[j];if(!n||n.nodeType!==1)continue;
          if(isTextField(n))suppress(n);
          if(n.querySelectorAll){var fs=n.querySelectorAll('input,textarea');for(var x=0;x<fs.length;x++)suppress(fs[x]);}
        }
      }
    });
    if(document.body)mo.observe(document.body,{childList:true,subtree:true});
    else document.addEventListener('DOMContentLoaded',function(){mo.observe(document.body,{childList:true,subtree:true});if(userOn())sweepSuppress();});
  }catch(_){}
  if(userOn())sweepSuppress();

  document.addEventListener('focusin',function(e){
    if(!userOn())return;
    var el=e.target;if(!isTextField(el))return;
    suppress(el);show(el);
  });
  document.addEventListener('focusout',function(e){
    setTimeout(function(){if(!isTextField(document.activeElement))hide();},130);
  });
  window.addEventListener('orientationchange',function(){setTimeout(function(){
    if(document.documentElement.classList.contains('dqkb-open')){var a=document.activeElement;if(isTextField(a))show(a);}
  },350);});
}catch(err){try{console&&console.warn&&console.warn('DQKB failed to init',err);}catch(e){}}
})();
