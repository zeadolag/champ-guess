import json,glob,re,collections,csv
CH='/tmp/claude-0/-home-claude/e1dda6d8-a8c9-5c45-b236-b09a160bfce7/scratchpad/dd/latest/data/en_US/champion/'
s=open('/home/claude/champ-guess/index.html').read();a=s.index('const RAW=`')+11;b=s.index('`',a)
R={}
for l in s[a:b].strip().split('\n'):
  f=l.split('|');R[f[0]]=dict(gender=f[1],pos=f[2].split(','),species=f[3].split(','),res=f[4],rng=f[5].split(','),reg=f[6].split(','),year=int(f[7]))
names=set(R)
DD={}
for f in glob.glob(CH+'*.json'):
  d=json.load(open(f))['data'];c=list(d.values())[0]
  if c['name'] in names:DD[c['name']]=c
cats=[]
EXTRA={"Rhaast"}
def add(color,name,members,kind,note=""):
  m=sorted(set(members)&(names|EXTRA))
  if len(m)>=4:cats.append(dict(color=color,category=name,members=m,kind=kind,note=note))
  elif kind!="Game data":print("TOO FEW",name,m)
G="Game data"
# ---- YELLOW: straightforward ----
for k in sorted({x for v in R.values() for x in v['reg']}):add("Yellow",f"From {k}",[n for n,v in R.items() if k in v['reg']],G)
for k in ["Yordle","Vastaya","Darkin","Undead","Revenant","Golem","Iceborn","Celestial","Aspect","God","Demon","Spirit","Cyborg","Dragon","Void-Being","Brackern","Troll","Minotaur","Cat","Plant","Spiritualist","Magicborn","Chemically Altered","Magically Altered","God-Warrior"]:
  add("Yellow" if k in("Yordle","Vastaya","Darkin","Undead","Golem","Dragon","Demon","God") else "Green",f"Species: {k}",[n for n,v in R.items() if k in v['species']],G)
for k in sorted({v['res'] for v in R.values()}):
  if k!="Mana":add("Green" if k not in("Energy","Manaless") else "Yellow",f"Resource: {k}",[n for n,v in R.items() if v['res']==k],G)
add("Green","Can switch between melee and ranged",[n for n,v in R.items() if len(v['rng'])>1],G)
add("Green","Gender: neither male nor female",[n for n,v in R.items() if v['gender']=="Other"],G)
add("Yellow","Has an apostrophe in their name",[n for n in names if "'" in n],G)
add("Yellow","Name is two (or more) words",[n for n in names if " " in n],G)
# classes
tags=collections.defaultdict(list)
for n,c in DD.items():
  for t in c['tags']:tags[t].append(n)
SUB={"Enchanter":["Janna","Karma","Lulu","Milio","Nami","Renata Glasc","Seraphine","Sona","Soraka","Yuumi"],
"Catcher":["Bard","Blitzcrank","Ivern","Morgana","Neeko","Rakan","Thresh"],
"Juggernaut":["Darius","Dr. Mundo","Garen","Illaoi","Mordekaiser","Nasus","Sett","Shyvana","Trundle","Udyr","Urgot","Volibear","Yorick","Aatrox"],
"Diver":["Camille","Diana","Elise","Hecarim","Irelia","Jarvan IV","Kled","Lee Sin","Olaf","Pantheon","Rek'Sai","Renekton","Skarner","Vi","Warwick","Wukong","Xin Zhao"],
"Burst mage":["Ahri","Annie","LeBlanc","Lissandra","Lux","Orianna","Syndra","Twisted Fate","Veigar","Zoe"],
"Battlemage":["Anivia","Aurelion Sol","Cassiopeia","Karthus","Malzahar","Rumble","Ryze","Swain","Taliyah","Viktor","Vladimir"],
"Artillery mage":["Vel'Koz","Xerath","Ziggs","Lux"],
"Assassin":["Akali","Evelynn","Fizz","Kassadin","Katarina","Kha'Zix","Pyke","Qiyana","Rengar","Shaco","Talon","Zed"],
"Skirmisher":["Bel'Veth","Fiora","Gwen","Jax","Master Yi","Nilah","Riven","Sylas","Tryndamere","Viego","Yasuo","Yone"],
"Vanguard":["Alistar","Amumu","Gragas","Leona","Malphite","Maokai","Nautilus","Nunu & Willump","Ornn","Rammus","Rell","Sejuani","Sion","Zac"],
"Warden":["Braum","Galio","K'Sante","Poppy","Shen","Tahm Kench","Taric"],
"Specialist":["Azir","Cho'Gath","Fiddlesticks","Gangplank","Gnar","Graves","Heimerdinger","Kayle","Kennen","Quinn","Singed","Teemo","Zilean"]}
for t,L in SUB.items():add("Yellow" if t in("Assassin","Enchanter","Juggernaut") else "Green",f"Subclass: {t}",L,"Lore/gameplay","Riot subclass (from memory, check)")
add("Yellow","Class: Marksman",tags["Marksman"],G,"Riot's class tag")
# ---- GREEN: years ----
for y in sorted({v['year'] for v in R.values()}):add("Green",f"Released in {y}",[n for n,v in R.items() if v['year']==y],G)
add("Green","Released 2021 or later",[n for n,v in R.items() if v['year']>=2021],G)
# positions single-role
for p in ["Top","Jungle","Middle","Bottom","Support"]:add("Yellow",f"Plays {p} (main role)",[n for n,v in R.items() if v['pos'][0]==p],G)
# ---- BLUE: skin lines ----
lines=collections.defaultdict(set);prest=set();esports=set();vict=set()
ESP={"SKT T1","T1","iG","SSG","DRX","FPX","EDG","DWG","Fnatic","TPA","SSW","Worlds 2013"}
for n,c in DD.items():
  for sk in c['skins']:
    if sk.get('parentSkin') is not None or sk['num']==0:continue
    ln=re.sub(r'\s+',' ',sk['name'].replace(n,'')).strip()
    if ln.startswith("Prestige"):prest.add(n);continue
    if ln in ESP:esports.add(n);continue
    if ln=="Victorious":vict.add(n);continue
    lines[ln].add(n)
SKIP={"Classic"}
for ln,m in sorted(lines.items(),key=lambda x:-len(x[1])):
  if ln in SKIP or len(m)<4:continue
  col="Blue" if len(m)>=8 else "Purple"
  add(col,f"Has a {ln.rstrip(':')} skin",m,"Skin data")
add("Blue","Has a Worlds-winning team skin",esports,"Skin data")
add("Blue","Has a Victorious skin (ranked reward)",vict,"Skin data")
# ---- titles ----
tw=collections.defaultdict(set)
for n,c in DD.items():
  for w in re.findall(r"[A-Za-z']+",c['title']):
    w=w.lower()
    if w in("the","of","a","an","and"):continue
    tw[w].add(n)
for w,m in sorted(tw.items(),key=lambda x:-len(x[1])):
  if len(m)>=4:add("Blue",f'Title contains the word "{w}"',m,"Title data","e.g. "+"; ".join(f"{x}: {DD[x]['title']}" for x in sorted(m)[:3]))
# ---- PURPLE: wordplay (computed) ----
alpha=lambda n:re.sub(r"[^a-z]","",n.lower())
add("Purple","Name has 3 letters or fewer",[n for n in names if len(alpha(n))<=3],"Name")
add("Purple","Name has a double letter",[n for n in names if re.search(r"(.)\1",alpha(n))],"Name")
add("Purple","Name contains another champion's name",[n for n in names if any(len(alpha(o))>=3 and alpha(o) in alpha(n) and o!=n for o in names)],"Name","e.g. Vi in Viktor? (2 letters excluded)")
ANIM=["ram","ant","hen","ass","cat","rat","bat","owl","eel","emu","yak","elk","ape","asp","bee","cow","dog","pig","fox","gnu","hog","doe","koi","ox"]
hid=collections.defaultdict(list)
for n in names:
  for a2 in ANIM:
    if a2 in alpha(n):hid[n].append(a2)
add("Purple","Hidden animal in the name",list(hid),"Name","; ".join(f"{n}→{'/'.join(v)}" for n,v in sorted(hid.items())))
# ---- ability & passive name words ----
aw=collections.defaultdict(set)
STOP={"the","of","a","an","and","to","in","on","for","from","with","my","your","s","x","its"}
for n,c in DD.items():
  for nm in [c['passive']['name']]+[sp['name'] for sp in c['spells']]:
    for w in re.findall(r"[A-Za-z]+",nm):
      w=w.lower()
      if w not in STOP and len(w)>2:aw[w].add(n)
for w,m in sorted(aw.items(),key=lambda x:-len(x[1])):
  if 4<=len(m)<=14 and w in {"dragon","darkin","void","hextech","glacial","lightning","blood","storm","dance","mega","shadow","spirit","fire","arcane","soul","breath","wrath","darkness","fury","rage","frenzy"}:
    ex="; ".join(f"{x}: "+next(nm for nm in [DD[x]['passive']['name']]+[sp['name'] for sp in DD[x]['spells']] if re.search(r'\b'+w+r'\b',nm,re.I)) for x in sorted(m)[:3])
    add("Purple" if len(m)<=6 else "Blue",f'Has an ability with "{w.capitalize()}" in its name',m,"Ability names",ex)
# ---- curated (lore, gameplay, wordplay) — need checking ----
C=[
("Blue","Has a sibling who is also a champion",["Kayle","Morgana","Darius","Draven","Katarina","Cassiopeia","Yasuo","Yone","Lux","Garen","Vi","Jinx"]),
("Green","Darkin",["Aatrox","Varus","Naafiri","Zaahen","Rhaast"]),
("Blue","Ascended (Shurima)",["Azir","Nasus","Renekton","Xerath"]),
("Blue","Kinkou order (current or former)",["Shen","Kennen","Akali","Zed"]),
("Blue","Black Rose members",["LeBlanc","Vladimir","Elise","Cassiopeia"]),
("Blue","Enemies of the Black Rose",["Swain","Mel","Ambessa","Mordekaiser","Darius"]),
("Blue","Appears in Arcane",["Jinx","Vi","Caitlyn","Jayce","Viktor","Heimerdinger","Singed","Ekko","Mel","Warwick","Ambessa","Sevika"]),
("Blue","Victim of the Ruination",["Viego","Kalista","Hecarim","Thresh","Gwen"]),
("Blue","In a romantic couple with another champion",["Xayah","Rakan","Lucian","Senna"]),
("Blue","Pirates of Bilgewater",["Gangplank","Miss Fortune","Graves","Twisted Fate"]),
("Green","Has a companion",["Annie","Kled","Nunu & Willump","Ivern","Lulu","Quinn","Kindred","Yuumi"]),
("Blue","Fights with a gun",["Graves","Miss Fortune","Lucian","Caitlyn","Jinx","Tristana","Corki","Gangplank","Samira","Senna","Akshan","Jhin","Aphelios"]),
("Blue","Fights with a bow or crossbow",["Ashe","Varus","Kindred","Vayne"]),
("Blue","Shapeshifter / has a second form",["Nidalee","Elise","Jayce","Gnar","Shyvana","Neeko"]),
("Blue","Comes back to life / has a death passive",["Sion","Karthus","Zac","Anivia","Kog'Maw"]),
("Blue","Global or near-global ultimate",["Shen","Twisted Fate","Karthus","Soraka","Gangplank","Ezreal","Jinx","Draven","Ashe","Senna","Pantheon"]),
("Blue","Can go invisible or camouflaged",["Twitch","Evelynn","Akali","Shaco","Rengar","Talon","Kha'Zix","Vayne","Wukong","Pyke"]),
("Blue","Creates a clone or decoy",["Shaco","LeBlanc","Wukong","Neeko"]),
("Blue","Can put up walls or terrain",["Anivia","Jarvan IV","Azir","Trundle","Taliyah","Ornn"]),
("Blue","Walks on four legs",["Hecarim","Skarner","Kog'Maw","Rek'Sai","Naafiri","Yuumi"]),
("Blue","Ultimate can execute low-health enemies",["Garen","Darius","Cho'Gath","Pyke","Urgot"]),
("Blue","Has a hook or grab ability",["Blitzcrank","Thresh","Nautilus","Pyke"]),
("Blue","Throws a boomerang-style returning ability",["Ahri","Sivir","Akshan","Ekko"]),
("Purple","Name is a real English word",["Brand","Graves","Gnar","Jinx","Karma","Rumble","Riven","Smolder","Swain","Talon","Thresh","Trundle","Vex","Fizz","Lux"]),

("Purple","Shares a name with something in real life",["Ashe","Annie","Lux","Karma","Nami","Sona","Tristana","Kayle"]),

("Blue","Orphans",["Jinx","Vi","Ekko","Akali"]),
("Blue","Was a soldier in an army",["Riven","Talon","Darius","Sion","Garen","Xin Zhao","Sona"]),
("Blue","Royalty (king, queen, prince, princess, emperor)",["Jarvan IV","Ashe","Azir","Sejuani","Viego","Qiyana","Lissandra"]),

("Blue","Is (or was) a criminal / thief",["Twisted Fate","Graves","Jinx","Vi","Pyke","Samira"]),
("Blue","Has wings",["Kayle","Morgana","Anivia","Swain","Aatrox","Galio","Smolder","Shyvana"]),
("Blue","Wears a mask",["Jhin","Zed","Kindred","Shaco","Yone"]),
 ("Blue","Received a full visual & gameplay update (VGU)",["Aatrox","Sion","Poppy","Warwick","Mordekaiser","Fiddlesticks","Volibear","Udyr","Skarner","Swain","Irelia","Akali","Galio","Evelynn","Pantheon","Dr. Mundo","Taric","Urgot","Kayle","Morgana","Nunu & Willump"]),
("Blue","Dog or wolf themed",["Nasus","Warwick","Naafiri","Kindred"]),
("Blue","Bird themed",["Anivia","Azir","Quinn","Swain","Xayah","Rakan"]),
("Blue","Uses fire",["Brand","Annie","Smolder","Shyvana"]),
("Blue","Uses ice",["Lissandra","Ashe","Anivia","Sejuani","Nunu & Willump","Braum","Trundle"]),
("Blue","Uses lightning",["Kennen","Volibear","Zeri","Xerath"]),
("Blue","Uses shadows",["Zed","Nocturne","Evelynn","Kayn"]),
("Blue","Musicians",["Sona","Seraphine","Bard"]),
("Blue","Artists",["Hwei","Jhin","Seraphine","Sona"]),
("Blue","Inventor or scientist",["Heimerdinger","Jayce","Viktor","Ziggs","Singed","Ekko","Rumble"]),
("Blue","Was created or built by someone else",["Blitzcrank","Orianna","Zac","Galio","Warwick","Briar"]),
("Green","Heals allies",["Soraka","Sona","Nami","Yuumi","Taric","Milio","Seraphine"]),
("Purple","Lore: is a child",["Annie","Nunu & Willump","Smolder"]),
("Blue","Wields a giant hammer",["Poppy","Jayce","Ornn"]),
("Blue","Dual-wields weapons",["Katarina","Samira","Akali","Aphelios","Kayle","Lucian","Vi"]),
]
for col,nm,m in C:add(col,nm,m,"Lore/gameplay","CHECK members")
# ---- League terms (answers don't have to be champions) ----
def free(color,name,members,note=""):
  cats.append(dict(color=color,category=name,members=list(members),kind="League terms",note=note))
add("Blue","Champions that grant vision",["Ashe","Quinn","Fiddlesticks","Kalista"],"Lore/gameplay","CHECK members")
free("Yellow","Summoner spells",["Flash","Ignite","Teleport","Smite","Heal","Barrier","Exhaust","Cleanse","Ghost"])
free("Yellow","Jungle camps",["Gromp","Krugs","Raptors","Murk Wolves","Blue Sentinel","Red Brambleback","Rift Scuttler"])
free("Yellow","Elemental dragons",["Infernal","Mountain","Ocean","Cloud","Hextech","Chemtech"])
free("Green","Epic monsters",["Baron Nashor","Rift Herald","Voidgrubs","Atakhan","Elder Dragon"])
free("Yellow","Rune trees",["Precision","Domination","Sorcery","Resolve","Inspiration"])
free("Green","Keystone runes",["Conqueror","Electrocute","Dark Harvest","Hail of Blades","Phase Rush","Arcane Comet","Summon Aery","Grasp of the Undying","Aftershock","Guardian","Press the Attack","Lethal Tempo","Fleet Footwork","First Strike","Glacial Augment","Unsealed Spellbook"],"Check against the current rune list")
free("Yellow","Multikills",["Double Kill","Triple Kill","Quadra Kill","Penta Kill"])
free("Yellow","Wards and trinkets",["Stealth Ward","Control Ward","Oracle Lens","Farsight Alteration"])
free("Green","Potions",["Health Potion","Refillable Potion","Corrupting Potion","Cappa Juice"])
free("Green","Elixirs",["Elixir of Iron","Elixir of Sorcery","Elixir of Wrath","Elixir of Skill","Elixir of Avarice","Elixir of Force"],"Check which are in the game now")
free("Green","Doran's items",["Doran's Blade","Doran's Ring","Doran's Shield","Doran's Bow","Doran's Helm"])
free("Green","Hydra items",["Tiamat","Ravenous Hydra","Titanic Hydra","Profane Hydra"])
free("Green","Map structures",["Turret","Inhibitor","Nexus","Fountain"])
free("Blue","Support quest upgrades",["Bloodsong","Celestial Opposition","Dream Maker","Solstice Sleigh","Zaz'Zak's Realmspike"])
free("Blue","Tier 3 boots",["Swiftmarch","Gunmetal Greaves","Chainlaced Crushers","Armored Advance","Spellslinger's Shoes","Crimson Lucidity","Immortal Path"],"Check names")
free("Blue","Starter jungle pets",["Scorchclaw Pup","Gustwalker Hatchling","Mosstomper Seedling"])
free("Purple","Items named after a person",["Rabadon's Deathcap","Zhonya's Hourglass","Rylai's Crystal Scepter","Liandry's Torment","Luden's Echo","Mejai's Soulstealer","Lord Dominik's Regards","Guinsoo's Rageblade","Randuin's Omen","Mikael's Blessing","Zeke's Convergence","Shurelya's Battlesong","Serylda's Grudge","Sterak's Gage","Runaan's Hurricane","Warmog's Armor","Youmuu's Ghostblade","Caulfield's Warhammer","Bami's Cinder"])
free("Blue","Items with 'Hextech' in the name",["Hextech Alternator","Hextech Gunblade","Hextech Rocketbelt","Hextech Dragon"],"Mix of items and a dragon on purpose")
free("Purple","Summoner spells that are everyday words",["Flash","Ghost","Heal","Barrier","Exhaust","Cleanse","Ignite","Smite"])
free("Blue","Crystal items",["Ruby Crystal","Sapphire Crystal","Rylai's Crystal Scepter","Crystalline Bracer"])
free("Green","Lanes and map areas",["Top","Mid","Bot","River","Jungle","Base"])
print(len(cats))
json.dump(cats,open('cats.json','w'),ensure_ascii=False,indent=0)
with open('cats.csv','w',newline='') as f:
  w=csv.writer(f);w.writerow(["Color","Category","Source","Members","Count","Notes","Keep?"])
  for c in cats:w.writerow([c['color'],c['category'],c['kind'],", ".join(c['members']),len(c['members']),c['note'],""])
from collections import Counter;print(Counter(c['color'] for c in cats),Counter(c['kind'] for c in cats))
