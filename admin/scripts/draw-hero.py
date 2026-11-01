import random, sys
random.seed(7)
W,H=1600,640
out=[]
a=out.append
a(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMax slice" role="img" aria-label="Illustration: a travel trailer and a mobile RV service truck at a mountain campground at dusk">')
a('''<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E2236"/><stop offset=".22" stop-color="#1D3352"/><stop offset=".38" stop-color="#5A4B6A"/><stop offset=".46" stop-color="#D0704C"/><stop offset=".54" stop-color="#F6A55B"/><stop offset="1" stop-color="#F6A55B"/></linearGradient>
<radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFE3A8"/><stop offset=".55" stop-color="#FFC77A" stop-opacity=".9"/><stop offset="1" stop-color="#FFC77A" stop-opacity="0"/></radialGradient>
<radialGradient id="fire" cx=".5" cy=".6" r=".5"><stop offset="0" stop-color="#FFB45A" stop-opacity=".75"/><stop offset="1" stop-color="#FF7A1A" stop-opacity="0"/></radialGradient>
<linearGradient id="lake" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9955A"/><stop offset="1" stop-color="#3A4F6A"/></linearGradient>
</defs>''')
a(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
# stars
for i in range(70):
    x=random.uniform(0,W); y=random.uniform(0,H*0.24); r=random.choice([0.8,1,1.2,1.6])
    a(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{r}" fill="#FFF7E6" opacity="{random.uniform(.35,.9):.2f}"/>')
# sun glow
a('<circle cx="1110" cy="300" r="190" fill="url(#sun)"/><circle cx="1110" cy="300" r="58" fill="#FFE3A8"/>')
def ridge(base, amp, n, seed, jag=0.0):
    random.seed(seed)
    pts=[(0,H)]
    xs=[i*W/n for i in range(n+1)]
    for x in xs:
        pts.append((x, base-random.uniform(0.25,1)*amp))
    pts.append((W,H))
    return pts
def path(pts): return 'M'+' L'.join(f'{x:.0f},{y:.0f}' for x,y in pts)+' Z'
# far range (bluish) with snowcaps
far=[(0,H),(0,380),(90,330),(170,350),(260,268),(330,300),(400,250),(470,292),(560,236),(640,286),(720,262),(800,300),(900,226),(980,276),(1060,250),(1150,300),(1240,244),(1330,282),(1420,232),(1510,280),(1600,262),(1600,H)]
a(f'<path d="{path(far)}" fill="#5A6C8C"/>')
# snowcaps on sharp peaks
for (px,py) in [(260,268),(400,250),(560,236),(900,226),(1240,244),(1420,232)]:
    a(f'<path d="M{px-26},{py+30} L{px},{py} L{px+28},{py+32} L{px+12},{py+24} L{px+2},{py+34} L{px-10},{py+22} Z" fill="#E8EEF5" opacity=".85"/>')
mid=[(0,H),(0,430),(120,372),(230,410),(340,350),(450,398),(560,360),(690,412),(800,372),(930,420),(1040,380),(1190,430),(1300,392),(1420,428),(1520,388),(1600,410),(1600,H)]
a(f'<path d="{path(mid)}" fill="#34496A"/>')
# lake reflection band
a('<path d="M0,500 Q400,488 800,498 T1600,494 L1600,540 L0,540 Z" fill="url(#lake)" opacity=".55"/>')
# tree line (dark forest)
def pine(x,base,h,col):
    w=h*0.42
    return (f'<path d="M{x:.0f},{base-h:.0f} L{x+w*0.45:.0f},{base-h*0.62:.0f} L{x+w*0.25:.0f},{base-h*0.62:.0f} L{x+w*0.62:.0f},{base-h*0.3:.0f} L{x+w*0.38:.0f},{base-h*0.3:.0f} L{x+w*0.8:.0f},{base:.0f} L{x-w*0.8:.0f},{base:.0f} L{x-w*0.38:.0f},{base-h*0.3:.0f} L{x-w*0.62:.0f},{base-h*0.3:.0f} L{x-w*0.25:.0f},{base-h*0.62:.0f} L{x-w*0.45:.0f},{base-h*0.62:.0f} Z" fill="{col}"/>'
            f'<rect x="{x-3:.0f}" y="{base-2:.0f}" width="6" height="10" fill="{col}"/>')
random.seed(3)
a('<path d="M0,520 Q300,500 600,515 T1200,510 T1600,512 L1600,560 L0,560 Z" fill="#1F3D35"/>')
x=-10
while x<W+20:
    h=random.uniform(60,120); a(pine(x,530,h,'#1F3D35')); x+=random.uniform(26,48)
random.seed(11)
x=-20
while x<W+20:
    h=random.uniform(90,170)
    if not (700<x<1520): a(pine(x,580,h,'#16302A'))
    x+=random.uniform(40,80)
# ground
a('<path d="M0,560 Q500,548 900,560 T1600,556 L1600,640 L0,640 Z" fill="#142823"/>')
# road / gravel pad
a('<path d="M560,640 Q760,590 1000,585 L1600,585 L1600,640 Z" fill="#2B2F33"/>')
a('<path d="M600,640 Q790,600 1010,596 L1600,596" stroke="#FF7A1A" stroke-width="3" stroke-dasharray="22 18" fill="none" opacity=".8"/>')

vx,vy=760,500
# ---- travel trailer (right) ----
tx,ty=1070,478   # top-left of trailer body
a(f'''<g>
<rect x="{tx}" y="{ty}" width="300" height="108" rx="40" fill="#F4EBDD"/>
<rect x="{tx}" y="{ty+56}" width="300" height="12" fill="#FF7A1A"/>
<rect x="{tx}" y="{ty+70}" width="300" height="6" fill="#10243A"/>
<rect x="{tx+30}" y="{ty+18}" width="88" height="32" rx="10" fill="#27405F"/>
<rect x="{tx+34}" y="{ty+22}" width="38" height="24" rx="6" fill="#F6A55B" opacity=".75"/>
<rect x="{tx+186}" y="{ty+16}" width="44" height="80" rx="8" fill="#E2D6C3" stroke="#10243A" stroke-width="2"/>
<circle cx="{tx+222}" cy="{ty+58}" r="3" fill="#10243A"/>
<rect x="{tx+244}" y="{ty+20}" width="38" height="26" rx="8" fill="#27405F"/>
<rect x="{tx+60}" y="{ty-10}" width="70" height="12" rx="4" fill="#C9BEAD"/>
<path d="M{tx+300},{ty+86} L{tx+370},{ty+104}" stroke="#2B2F33" stroke-width="8" stroke-linecap="round"/>
<rect x="{tx+340}" y="{ty+100}" width="8" height="20" fill="#2B2F33"/>
<circle cx="{tx+150}" cy="{ty+112}" r="22" fill="#111"/><circle cx="{tx+150}" cy="{ty+112}" r="9" fill="#8C939A"/>
<path d="M{tx+120},{ty+102} Q{tx+150},{ty+80} {tx+180},{ty+102}" fill="#10243A"/>
</g>''')
# awning + camp chair + fire
a(f'''<path d="M{tx+20},{ty+14} L{tx+170},{ty+14} L{tx+190},{ty+40} L{tx+40},{ty+40} Z" fill="#2F5D50" opacity=".0"/>
<ellipse cx="{vx-90}" cy="590" rx="70" ry="38" fill="url(#fire)"/>
<path d="M{vx-110},592 L{vx-70},584 M{vx-108},584 L{vx-72},594" stroke="#5A3A22" stroke-width="5" stroke-linecap="round"/>
<path d="M{vx-90},586 Q{vx-104},566 {vx-92},548 Q{vx-88},566 {vx-80},556 Q{vx-76},572 {vx-90},586 Z" fill="#FF9A3C"/>
<path d="M{vx-90},586 Q{vx-96},574 {vx-90},564 Q{vx-86},576 {vx-90},586 Z" fill="#FFE3A8"/>''')

a(f'<path d="M{vx-150},590 l10,-26 l22,0 l-6,26 M{vx-140},578 l18,0" stroke="#2F5D50" stroke-width="5" fill="none" stroke-linecap="round"/>')
# ---- mobile service truck (left of trailer) ----
vx,vy=760,500
a(f'''<g>
<path d="M{vx},{vy+20} Q{vx},{vy} {vx+20},{vy} L{vx+150},{vy} L{vx+150},{vy+80} L{vx},{vy+80} Z" fill="#10243A"/>
<path d="M{vx+150},{vy+24} L{vx+200},{vy+24} Q{vx+214},{vy+24} {vx+222},{vy+40} L{vx+236},{vy+56} L{vx+236},{vy+80} L{vx+150},{vy+80} Z" fill="#10243A"/>
<path d="M{vx+160},{vy+32} L{vx+198},{vy+32} Q{vx+208},{vy+32} {vx+214},{vy+42} L{vx+222},{vy+54} L{vx+160},{vy+54} Z" fill="#7FA6C9" opacity=".85"/>
<rect x="{vx}" y="{vy+46}" width="236" height="8" fill="#FF7A1A"/>
<rect x="{vx+8}" y="{vy-12}" width="134" height="6" rx="2" fill="#8C939A"/>
<rect x="{vx+16}" y="{vy-12}" width="4" height="12" fill="#8C939A"/><rect x="{vx+130}" y="{vy-12}" width="4" height="12" fill="#8C939A"/>
<rect x="{vx+40}" y="{vy-20}" width="40" height="8" rx="3" fill="#FF7A1A"/>
<g transform="translate({vx+52},{vy+12}) scale(.42)"><rect width="64" height="64" rx="14" fill="#FF7A1A"/><path d="M32 54c-1.2 0-2.2-.6-2.9-1.6C24 45 15 35.4 15 26.5 15 17.4 22.6 10 32 10s17 7.4 17 16.5C49 35.4 40 45 34.9 52.4c-.7 1-1.7 1.6-2.9 1.6z" fill="#10243A"/><circle cx="32" cy="26" r="8" fill="#FF7A1A"/><rect x="29" y="33" width="6" height="9" rx="2" fill="#FF7A1A"/></g>
<circle cx="{vx+44}" cy="{vy+84}" r="20" fill="#111"/><circle cx="{vx+44}" cy="{vy+84}" r="8" fill="#8C939A"/>
<circle cx="{vx+190}" cy="{vy+84}" r="20" fill="#111"/><circle cx="{vx+190}" cy="{vy+84}" r="8" fill="#8C939A"/>
<rect x="{vx+228}" y="{vy+58}" width="10" height="8" rx="2" fill="#FFE3A8"/>
</g>''')
# headlight beam
a(f'<path d="M{vx+238},{vy+62} L{vx+330},{vy+40} L{vx+330},{vy+92} Z" fill="#FFE3A8" opacity=".12"/>')
# foreground pines framing right edge
random.seed(21)
for xx in [1480,1540,1590]:
    a(pine(xx,640,random.uniform(200,260),'#0E1F1B'))
a(pine(30,640,230,'#0E1F1B')); a(pine(90,640,180,'#0E1F1B'))
a('</svg>')
open(sys.argv[1],'w').write('\n'.join(out))
