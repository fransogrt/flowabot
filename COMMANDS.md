# Commands
### Table of contents
- [;addpp](#addpp)
- [;ar](#ar)
- [;bmi](#bmi)
- [;bpm](#bpm)
- [;calcscore](#calcscore)
- [;compare](#compare)
- [;firsts](#firsts)
- [;matchcosts](#matchcosts)
- [;fucking](#fucking)
- [;help](#help)
- [;ign-set](#ign-set)
- [;lazerscore](#lazerscore)
- [;level](#level)
- [;lol](#lol)
- [;oppai](#oppai)
- [;oppai2](#oppai2)
- [;osu](#osu)
- [;osu-track](#osu-track)
- [;osu-untrack](#osu-untrack)
- [;packs](#packs)
- [;ping](#ping)
- [;ping2](#ping2)
- [;pins](#pins)
- [;recent](#recent)
- [;render](#render)
- [;rosu](#rosu)
- [;score](#score)
- [;strains](#strains)
- [;tap](#tap)
- [;time](#time)
- [;top](#top)
- [;tops](#tops)
- [;valorant](#valorant)
- [;w;](#w)
- [;with](#with)
---
## ;addpp
Calculate new total pp after achieving a certain top play.

**Usage**: `;addpp <amounts separated by +> [username] [beatmap_id]`
### Examples:

```
;addpp 300
```
Returns your total pp with an additional 300pp score.

```
;addpp 300+350
```
Returns your total pp with an additional 300 and 350pp score.

```
;addpp 1100 Vaxei 1860433
```
Returns Vaxei's total pp if their score on /b/1860433 awarded 1100pp.
## ;ar
Calculate Approach Rate values and miliseconds with mods applied.

**Usage**: `;ar <ar> [+mods]`
### Example:

```
;ar 8 +DT
```
Returns AR of AR8 with DT applied.
## ;bmi
Calculate your BMI.

**Usage**: `;bmi <height in m or cm> <weight in kg>`
### Examples:

```
;bmi 185cm 70kg
```

```
;bmi 1.56m 56kg
```
## ;bpm
Show a visual BPM graph over time for a beatmap.

**Usage**: `;bpm [beatmap url] [+mods]`
### Examples:

```
;bpm
```
Returns BPM graph for the last beatmap.

```
;bpm https://osu.ppy.sh/b/75 +DT
```
Returns BPM graph with DT for specific beatmap.
## ;calcscore
Calculate maximum score for a beatmap.

**Variations**: `;calcscore`, `;scorecalc`, `;cs`

**Usage**: `;calcscore <map link> [+mods]`
### Examples:

```
;calcscore https://osu.ppy.sh/b/75
```
Returns the maximum score for Disco Prince with no mods.

```
;calcscore https://osu.ppy.sh/b/75 +HDHRDT
```
Returns the maximum score for Disco Prince +HDHRDT.
## ;compare
Search for best score on the last beatmap.

**Variations**: `;compare`, `;c`

**Usage**: `;compare [username or * for all users] [+mods]`
### Examples:

```
;compare
```
Returns your own best score on the last beatmap.

```
;compare Vaxei +mods
```
Returns Vaxei's best score with the same mods on the last beatmap.

```
;compare * +HD
```
Returns the #1 HD score on the last beatmap.
## ;matchcosts
Calculate match cost for all players in a tournament match.

**Variations**: `;matchcosts`, `;matchcost`, `;mc`

**Usage**: `;matchcosts <match url or id> [warmups]`
### Examples:

```
;matchcosts https://osu.ppy.sh/community/matches/123456789
```
Returns match cost for all players.

```
;mc https://osu.ppy.sh/mp/123456789 2
```
Returns match cost skipping the first 2 warmup maps.
## ;firsts
Show a list of first places

**Usage**: `;firsts [username]`
### Examples:

```
;firsts
```
Returns your top 5 first places.

```
;firsts7 vaxei
```
Returns Vaxei's top 7 first places.
## ;fucking

**Usage**: `;fucking`
## ;help
Get help for a command.

**List of all commands:** https://github.com/fransogrt/flowabot/blob/main/COMMANDS.md

**Usage**: `;help <command>`
### Example:

```
;help pp
```
Returns help on how to use the `;pp` command.
## ;ign-set
Sets your osu! username so you can use osu! commands without specifying a username.

**Usage**: `;ign-set <osu! username>`
### Example:

```
;ign-set nathan on osu
```
Sets your osu! username to nathan on osu.
## ;lazerscore
Calculate maximum lazer classic score for a beatmap.

**Variations**: `;lazerscore`, `;ls`, `;classicscore`

**Usage**: `;lazerscore <map link> [+mods]`
### Examples:

```
;ls https://osu.ppy.sh/b/75
```
Returns the maximum lazer classic score for Disco Prince with no mods.

```
;classicscore https://osu.ppy.sh/b/75 +HDHRDT
```
Returns the maximum lazer classic score for Disco Prince +HDHRDT.
## ;level
Calculate experimental level.

**Usage**: `;level [username]`
### Examples:

```
;level
```
Calculates your experimental level.

```
;level mrekk
```
Calculates mrekk's experimental level.
## ;lol
Show League of Legends profile.

**Variations**: `;lol`, `;league`

**Usage**: `;lol <name#tag> [flex] [region]`
### Examples:

```
;lol thpr#EUW
```
Returns Solo/Duo profile on EUW.

```
;lol thpr#EUW flex
```
Returns Flex profile on EUW.

```
;lol Faker#KR1 kr
```
Returns Solo/Duo profile on KR.
## ;oppai
Uses oppai (2016 ppv2) to calculate pp for a beatmap.

**Usage**: `;oppai <map link> [+HDDT] [99.23%] [2x100] [1x50] [3m] [342x]`
### Example:

```
;oppai https://osu.ppy.sh/b/75 +DT 
```
Calculates pp on this beatmap with DT applied.
## ;oppai2
Uses oppai (2014 ppv2) to calculate pp for a beatmap.

**Usage**: `;oppai2 <map link> [+HDDT] [99.23%] [2x100] [1x50] [3m] [342x]`
### Example:

```
;oppai https://osu.ppy.sh/b/75 +DT 
```
Calculates pp on this beatmap with DT applied.
## ;osu
Show osu! stats.

**Variations**: `;osu`, `;osu2`

**Usage**: `;osu [username]`
### Example:

```
;osu nathan_on_osu
```
Returns nathan on osu's osu! stats.
## ;osu-track
Start tracking the specified user's osu! top plays in the current channel.

**Usage**: `;osu-track <username> [top play limit (1-100, default 50)]`
### Example:

```
;osu-track nathan_on_osu 50
```
Start tracking nathan on osu's top 50 top plays.
## ;osu-untrack
Stop tracking the specified user's osu! top plays in the current channel.

**Usage**: `;osu-untrack <username> [top play limit (1-100, default 50)]`
### Example:

```
;osu-untrack nathan_on_osu
```
Stop tracking nathan on osu's top plays.
## ;packs
Get the beatmap packs containing the given beatmap.

**Variations**: `;packs`, `;pack`

**Usage**: `;packs <map link> [+mods]`
### Example:

```
;packs https://osu.ppy.sh/b/75
```
Returns the packs containing the given beatmap Disco Prince.
## ;ping

**Usage**: `;ping`
## ;ping2
ping a website.

**Usage**: `;ping2 <url>`
### Example:

```
;ping google.com
```
Returns the time it took to ping google.com
## ;pins
Show a list of pinned plays

**Variations**: `;pins`, `;pinned`

**Usage**: `;pins [username]`
### Examples:

```
;pins
```
Returns your top 5 pinned plays.

```
;pins7 vaxei
```
Returns Vaxei's top 7 pinned plays.
## ;recent
Show recent score or pass.

**Variations**: `;recent`, `;rs`, `;recentpass`, `;rp`

**Usage**: `;recent [username]`
### Examples:

```
;recent nathan_on_osu
```
Returns nathan on osu's most recent score.

```
;recent3 respektive
```
Returns respektive's most recent score.

```
;recentpass
```
Returns your most recent pass.
## ;render
Render picture or gif of a beatmap at a specific time. Videos 10 seconds or longer are automatically rendered as mp4 video with audio and beatmap background.

**Variations**: `;render`, `;frame`, `;fail`

**Usage**: `;render [beatmap url] [+mods] [AR8] [CS6] [preview/strains/aim/speed/fail] [HD] [20%] [mp4] [plain] [120fps] [mm:ss] [353x] [4s]`
### Examples:

```
;render strains
```
Returns a gif of the hardest part on the last beatmap.

```
;fail
```
Returns a gif of the part where the player failed on the last beatmap.

```
;render 1:05
```
Returns an image of the last beatmap at 1 minute and 5 seconds.

```
;render speed 10s 50%
```
Returns a 10 second video of the streamiest part on the last beatmap at half speed.

```
;render 120fps 353x plain
```
Returns a 120fps video at 353 combo on the last beatmap without sound and black background.
## ;rosu
Uses rosu-pp to calculate pp for a beatmap.

**Variations**: `;rosu`, `;rosu-pp`, `;rpp`, `;pp`

**Usage**: `;rosu <map link> [+HDDT] [99.23%] [2x100] [1x50] [3m] [342x] [1.2*] [OD9.5] [AR10.3] [CS6] [HP8]`
### Examples:

```
;rosu https://osu.ppy.sh/b/75 +HD 4x100 343x CS2
```
Calculates pp on this beatmap with HD applied, 4 100s, 343 Combo and CS set to 2.

```
;rosu https://osu.ppy.sh/b/774965 99% 1.3*
```
Calculates pp on this beatmap with 99% accuracy and a custom speed rate of 1.3*.
## ;score
Search for a score on a beatmap.

**Usage**: `;score <beatmap url> [username or * for any user] [+mods]`
### Examples:

```
;score https://osu.ppy.sh/b/75 * +HD
```
Returns #1 score with HD on this beatmap.

```
;score https://osu.ppy.sh/b/75
```
Returns your best score on this beatmap.

```
;score5 https://osu.ppy.sh/b/75 *
```
Returns the #5 score on this beatmap.
## ;strains
Show a visual strain graph of the star raiting over time on a beatmap.

**Usage**: `;strains [beatmap url] [+mods] [AR8] [CS6] [aim/speed]`
### Examples:

```
;strains
```
Returns strain graph for the last beatmap.

```
;strains +HR CS5
```
Returns strain graph with HR applied and CS set to 5 for the last beatmap.

```
;strains https://osu.ppy.sh/b/75 aim
```
Returns aim strain graph for this beatmap.
## ;tap
Calculate BPM values for different beat snap divisors

**Usage**: `;tap <BPM> <Beat Snap Divisor>`
### Examples:

```
;tap 200 1/4
```
Return equivalent tapping values for 200 BPM at 1/4

```
;tap 150 1/3
```
Return equivalent tapping values for 150 BPM at 1/3
## ;time
Get the current time at a place.

**Usage**: `;time [name of place, e.g. city]`
### Example:

```
;time london
```
Returns the current time in London.
## ;top
Show a specific top play.

**Variations**: `;top`, `;rb`, `;recentbest`, `;ob`, `;oldbest`

**Usage**: `;top [username]`
### Examples:

```
;top
```
Returns your #1 top play.

```
;top5 vaxei
```
Returns Vaxei's #5 top play.

```
;rb
```
Returns your most recent top play.

```
;ob
```
Returns your oldest top play (from your top 100).
## ;tops
Show a list of top plays

**Usage**: `;tops [username]`
### Examples:

```
;tops
```
Returns your top 5 plays.

```
;tops7 vaxei
```
Returns Vaxei's top 7 plays.
## ;valorant
Show Valorant profile stats for the current season.

**Variations**: `;valorant`, `;val`

**Usage**: `;valorant <name#tag> [competitive|swiftplay]`
### Examples:

```
;val pipa#6908
```
Returns pipa's competitive stats for the current season.

```
;val pipa#6908 swiftplay
```
Returns pipa's swiftplay stats for the current season.
## ;w;

**Usage**: `;w;`
## ;with
Show pp values of a beatmap with several accuracies or a specified accuracy.

**Usage**: `;with [beatmap url] [+mods] [98.34%]`
### Examples:

```
;with
```
Returns pp values for the last beatmap with the same mods.

```
;with +
```
Returns pp values for the last beatmap without mods.

```
;with +HD 97.5%
```
Returns pp value for the last beatmap with 97.5% accuracy and HD applied.
