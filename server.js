const express=require("express"),path=require("path"),fs=require("fs"),crypto=require("crypto");
const app=express();app.use(express.json({limit:"20kb"}));app.use(express.static(path.join(__dirname,"public")));
const API_KEY=process.env.ANTHROPIC_API_KEY,MODEL=process.env.MODEL||"claude-sonnet-5-5";
const GEMINI_KEY=process.env.GEMINI_API_KEY,GEMINI_MODEL=process.env.GEMINI_MODEL||"gemini-2.5-flash";
const FILE=path.join(process.env.DATA_DIR||__dirname,"data.json");
let db={users:[],sessions:{},listings:[],pickups:[],orders:[]};
try{db={...db,...JSON.parse(fs.readFileSync(FILE))}}catch{}
const save=()=>{try{fs.writeFileSync(FILE,JSON.stringify(db))}catch(e){console.error(e.message)}};
const partners=require("./partners.json");
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString("hex");
const pub=u=>({name:u.name,email:u.email,role:u.role,city:u.city,businessName:u.businessName,address:u.address,phone:u.phone});
const session=u=>{const t=crypto.randomBytes(24).toString("hex");db.sessions[t]=u.id;save();return{token:t,user:pub(u)}};
const auth=(req,res,next)=>{const u=db.users.find(x=>x.id===db.sessions[(req.headers.authorization||"").slice(7)]);if(!u)return res.status(401).json({error:"Please log in."});req.user=u;next()};
const bad=(res,m,c=400)=>res.status(c).json({error:m});

app.post("/api/signup",(req,res)=>{
  const{name,email,password,role,city,businessName,address,phone}=req.body||{};
  if(!name||!email||!password||password.length<6||!city||!["restaurant","homekitchen","business"].includes(role))return bad(res,"Fill in name, email, city, role and a password of 6+ characters.");
  if(!businessName||!address||!phone)return bad(res,"Add your kitchen or business name, address and phone.");
  const e=email.toLowerCase().trim();if(db.users.find(u=>u.email===e))return bad(res,"That email already has an account. Log in instead.",409);
  const salt=crypto.randomBytes(16).toString("hex");
  const u={id:crypto.randomUUID(),name,email:e,salt,pw:hash(password,salt),role,city:city.trim(),businessName,address,phone};
  db.users.push(u);res.json(session(u));
});
app.post("/api/login",(req,res)=>{
  const{email,password}=req.body||{};const u=db.users.find(x=>x.email===String(email).toLowerCase().trim());
  if(!u||hash(String(password),u.salt)!==u.pw)return bad(res,"Wrong email or password.",401);res.json(session(u));
});
app.get("/api/me",auth,(req,res)=>res.json({user:pub(req.user)}));
app.get("/health",(_q,r)=>r.send("ok"));

const SYSTEM=`You are Sproutsy, the AI inside WasteWise, an app that decides where leftover food and recyclables should go.
Pathways (exact ids): "sell" (edible food listed at a reduced price on the marketplace), "donate" (edible food to nearby NGOs), "compost" (spoiled or unsafe food and plant scraps), "biogas" (spoiled meat, fish, dairy or oily food), "scrap" (paper, cardboard, plastic).
Rules:
- You support decisions; you NEVER certify food as safe to eat.
- If key details are missing (what it is, how long ago it was made, how it was stored), ask up to 3 short follow-up questions. Not needed for paper or plastic.
- Food that is spoiled, mouldy, smelly, 3+ days old (cooked or animal-based) or 5+ days old (other), or was left in the sun, heat or unrefrigerated, must NEVER go to sell or donate: use compost (biogas if it is meat, fish, dairy or oily).
- Recently made food stored properly can be sold or donated: use "sell" or "donate".
- Peels, tea/coffee grounds, eggshells and plant scraps: compost.
Reply with ONLY JSON:
{"status":"needs_info","questions":["..."]}
{"status":"result","category":"edible surplus | spoiled food | organic scraps | other food waste | paper or plastic","pathway":"sell|donate|compost|biogas|scrap","reason":"1-2 plain sentences addressed to the user","safety_note":"1 sentence","next_steps":["2-4 short steps"]}`;

const canSell=new Map(); // email -> time Sproutsy last offered sell/donate (one listing per offer, valid 2 hours)
const hits=new Map();const limited=ip=>{const n=Date.now(),a=(hits.get(ip)||[]).filter(t=>n-t<6e5);a.push(n);hits.set(ip,a);return a.length>30};

// Rule-based food check. This runs on every request so spoiled food can never be routed to sell or donate.
function assess(b){
  const ans=Array.isArray(b.answers)?b.answers.map(x=>x&&x.answer).join(" "):"";
  const t=[b.food,b.prepared,b.storage,ans].join(" ").toLowerCase();
  if(/(peel|scrap|shell|ground|stalk|husk|paper|cardboard|plastic|bottle|newspaper|carton|box|glass)/.test(String(b.food).toLowerCase()))return{skip:true};
  const animal=/\b(meat|chicken|fish|mutton|eggs?|dairy|milk|yogurt|curd|paneer|cheese|prawns?|beef|pork|oil|oily|fried|ghee|butter)\b/.test(t);
  const cooked=/\b(cooked|curry|rice|dal|roti|sabzi|gravy|biryani|meal|soup|noodles?|pasta)\b/.test(t);
  let days=null;const m=[...t.matchAll(/(\d+)\s*(day|week)/g)].map(x=>+x[1]*(x[2]==="week"?7:1));
  if(m.length)days=Math.max(...m);else if(/\bweek\b/.test(t))days=7;else if(/yesterday|last night/.test(t))days=1;else if(/today|hours? ago|this morning|just (made|cooked)|fresh/.test(t))days=0;
  const noFridge=/(not (in )?(the )?(fridge|refrigerat)|no fridge|without (a )?fridge|unrefrigerated)/.test(t);
  const fridged=/(fridge|refrigerat|freezer|sealed|airtight)/.test(t)&&!noFridge;
  const exposed=noFridge||/(in the sun|sunlight|outside|outdoors|left out|room temp|open air|hot car|in the heat)/.test(t);
  const spoiled=/(mou?ld|rotten|rotting|smells?\b|smelly|stink|sour|slimy|spoil|gone (bad|off)|fungus|stale|expired)/.test(t)&&!/(no (bad )?smell|doesn.?t smell|not spoil|no mou?ld)/.test(t);
  let why=null;
  if(spoiled)why="showing signs of spoilage";
  else if(exposed&&!fridged)why="left out in the sun or heat";
  else if(days!==null&&days>=((animal||cooked)?3:5))why=days+" days old";
  return{why,animal,days,known:days!==null,good:!why&&days!==null&&days<=1};
}
const result=(category,pathway,reason,safety_note,next_steps)=>({status:"result",category,pathway,reason,safety_note,next_steps});
const badResult=a=>{const p=a.animal?"biogas":"compost";return result("spoiled food",p,`This food is ${a.why}, so it is not safe to sell or donate. ${p==="compost"?"Composting is the right place for it.":"It goes to a biogas plant instead."}`,"Do not eat or serve this food.",["Seal it in a leak-proof container","Pick a collection time below"])};
const goodResult=()=>result("edible surplus","sell","This food is fresh and was stored well, so it can still be eaten. You can sell it at a reduced price or donate it.","Guidance only: check smell and texture before sharing.",["Pack it in a clean, covered container","Choose sell or donate below"]);
function fallback(b){
  const a=assess(b);
  if(/(paper|cardboard|plastic|bottle|newspaper|carton|box|glass)/.test(b.food.toLowerCase()))return result("paper or plastic","scrap","Paper and plastic can be recycled through a scrap dealer or waste paper collector.","Keep it dry and clean for a better price.",["Sort paper and plastic separately","Pick a collection time below"]);
  if(a.skip)return result("organic scraps","compost","Plant scraps break down well into compost.","Keep meat, dairy and oily food out.",["Keep in a dry covered bin","Pick a collection time below"]);
  if(!b.answers&&!a.known)return{status:"needs_info",questions:["When was it made or cooked?","How was it stored: in the fridge, on the counter, or somewhere hot?"]};
  if(a.good)return goodResult();
  return result("food of unknown age","compost","We could not confirm this food is fresh and well stored, so composting is the safe choice.","Do not eat or serve food you are unsure about.",["Seal it in a leak-proof container","Pick a collection time below"]);
}

// Uses Claude if ANTHROPIC_API_KEY is set, otherwise Gemini if GEMINI_API_KEY is set
async function askAI(msg){
  if(API_KEY){
    const r=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"content-type":"application/json","x-api-key":API_KEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:MODEL,max_tokens:700,system:SYSTEM,messages:[{role:"user",content:msg}]})});
    if(!r.ok)throw new Error("Anthropic API "+r.status);
    const d=await r.json();return d.content.filter(b=>b.type==="text").map(b=>b.text).join("");
  }
  const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":GEMINI_KEY},body:JSON.stringify({systemInstruction:{parts:[{text:SYSTEM}]},contents:[{role:"user",parts:[{text:msg}]}],generationConfig:{responseMimeType:"application/json",maxOutputTokens:2000}})});
  if(!r.ok)throw new Error("Gemini API "+r.status);
  const d=await r.json();return(d.candidates?.[0]?.content?.parts||[]).map(p=>p.text||"").join("");
}

app.post("/api/route",auth,async(req,res)=>{
  if(limited(req.ip))return bad(res,"Too many requests. Try again in a few minutes.",429);
  const{food,prepared,quantity,storage,answers}=req.body||{};const u=req.user;
  if(!food||typeof food!=="string"||food.length>300)return bad(res,"Tell Sproutsy what you have.");
  const a=assess(req.body);let out;
  if(a.why)out=badResult(a);
  else if(!API_KEY&&!GEMINI_KEY)out=fallback(req.body);
  else try{
    const msg=[`User role: ${u.role}${u.businessName?" ("+u.businessName+")":""}`,`City: ${u.city}`,`Item: ${food}`,`Prepared: ${prepared||"not given"}`,`Quantity: ${quantity||"not given"}`,`Storage: ${storage||"not given"}`,answers?`Follow-up answers: ${JSON.stringify(answers).slice(0,1000)}\nGive a result now.`:""].filter(Boolean).join("\n");
    const text=await askAI(msg);out=JSON.parse(text.replace(/```json|```/g,"").trim());
    if(!["needs_info","result"].includes(out.status))throw new Error("shape");
  }catch(e){console.error(e.message);out=fallback(req.body)}
  if(out.status==="result"){
    if(!a.skip&&a.good&&["compost","biogas"].includes(out.pathway))out=goodResult();
    const edible=["sell","donate"].includes(out.pathway);
    out.options=edible?["sell","donate"]:[out.pathway];
    if(edible)canSell.set(u.email,Date.now());
    if(edible){const c=u.city.toLowerCase(),n=partners.filter(p=>p.type==="ngo");out.partners=n.filter(p=>p.city.toLowerCase()===c).concat(n.filter(p=>p.city.toLowerCase()!==c)).slice(0,4)}
  }
  res.json(out);
});

app.post("/api/pickups",auth,(req,res)=>{
  const{pathway,summary,date,window:w,address}=req.body||{};
  if(!["compost","biogas","scrap"].includes(pathway)||!date||!w||!address)return bad(res,"Pick a date, time window and address.");
  db.pickups.push({id:crypto.randomUUID(),user:req.user.email,pathway,summary:String(summary||"").slice(0,300),date,window:w,address:String(address).slice(0,200),at:Date.now()});save();res.json({ok:true});
});

app.get("/api/listings",auth,(_q,res)=>res.json(db.listings.filter(l=>l.quantity>0).sort((a,b)=>b.at-a.at)));
app.post("/api/listings",auth,(req,res)=>{
  const u=req.user;
  if(Date.now()-(canSell.get(u.email)||0)>72e5)return bad(res,"Ask Sproutsy first. You can list food once Sproutsy recommends selling or donating it.",403);
  const{item,price,originalPrice,quantity,pickupBy}=req.body||{};
  if(!item||!(price>=0)||!(originalPrice>0)||!(quantity>0)||!pickupBy)return bad(res,"Fill in item, both prices, portions and pick-up time.");
  if(price>originalPrice)return bad(res,"The sale price should be lower than the original price.");
  canSell.delete(u.email);
  db.listings.push({id:crypto.randomUUID(),owner:u.email,item:String(item).slice(0,100),price:+price,originalPrice:+originalPrice,quantity:Math.floor(quantity),pickupBy:String(pickupBy).slice(0,80),seller:{name:u.businessName,address:u.address,phone:u.phone,city:u.city},at:Date.now()});save();res.json({ok:true});
});
app.post("/api/listings/:id/reserve",auth,(req,res)=>{
  const l=db.listings.find(x=>x.id===req.params.id),q=Math.floor(req.body?.qty||1);
  if(!l||q<1||q>l.quantity)return bad(res,"Not enough portions left.");
  if(l.owner===req.user.email)return bad(res,"You can't reserve your own listing.");
  const b=req.user;l.quantity-=q;db.orders.push({listing:l.id,item:l.item,price:l.price,qty:q,total:q*l.price,pickupBy:l.pickupBy,seller:{email:l.owner,...l.seller},buyer:{email:b.email,name:b.name,businessName:b.businessName,phone:b.phone,city:b.city},at:Date.now()});save();res.json({ok:true,seller:l.seller,total:q*l.price,pickupBy:l.pickupBy});
});

app.get("/api/history",auth,(req,res)=>{const e=req.user.email,o=[...db.orders].reverse();res.json({purchases:o.filter(x=>x.buyer&&x.buyer.email===e),sales:o.filter(x=>x.seller&&x.seller.email===e)})});

app.post("/api/profile",auth,(req,res)=>{
  const u=req.user,{name,email,role,city,businessName,address,phone}=req.body||{};
  const f=[name,email,city,businessName,address,phone];
  if(f.some(x=>!x||String(x).length>200)||!["restaurant","homekitchen","business"].includes(role))return bad(res,"Fill in every field, using under 200 characters each.");
  const e=String(email).toLowerCase().trim(),old=u.email;
  if(e!==old&&db.users.find(x=>x.email===e))return bad(res,"That email is already used by another account.",409);
  Object.assign(u,{name:String(name).trim(),email:e,role,city:String(city).trim(),businessName:String(businessName).trim(),address:String(address).trim(),phone:String(phone).trim()});
  if(e!==old){
    db.orders.forEach(o=>{if(o.buyer&&o.buyer.email===old)o.buyer.email=e;if(o.seller&&o.seller.email===old)o.seller.email=e});
    db.listings.forEach(l=>{if(l.owner===old)l.owner=e});db.pickups.forEach(p=>{if(p.user===old)p.user=e});
    if(canSell.has(old)){canSell.set(e,canSell.get(old));canSell.delete(old)}
  }
  db.listings.forEach(l=>{if(l.owner===e)l.seller={name:u.businessName,address:u.address,phone:u.phone,city:u.city}});
  save();res.json({user:pub(u)});
});
app.post("/api/password",auth,(req,res)=>{
  const{current,next}=req.body||{},u=req.user;
  if(hash(String(current),u.salt)!==u.pw)return bad(res,"Your current password is wrong.");
  if(!next||String(next).length<6)return bad(res,"The new password needs 6 or more characters.");
  u.salt=crypto.randomBytes(16).toString("hex");u.pw=hash(String(next),u.salt);save();res.json({ok:true});
});

app.listen(process.env.PORT||3000,()=>console.log("WasteWise running"));
