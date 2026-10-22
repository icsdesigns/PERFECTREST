# PerfectRest

Aplicación móvil para mejorar los horarios de sueño: fija una meta de descanso,
calcula la hora de acostarse que encaja con los ciclos de sueño y registra
cuánto duermes para enseñarte la tendencia.

Stack: **Vite + React + TypeScript**, empaquetada para Android con **Capacitor**.
Durante el desarrollo corre en el navegador; el APK se genera con el SDK de
Android ya instalado en la máquina.

---

## Puesta en marcha

```bash
npm install
npm run dev        # http://localhost:5173
```

Otros comandos:

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo con recarga en caliente |
| `npm run build` | Compila a `dist/` (lo que consume el APK) |
| `npm run typecheck` | Comprueba tipos sin compilar |
| `npm run check` | Ejecuta las comprobaciones de dominio, de noches simuladas, de precisión, el banco de pruebas con noches reales y el render |
| `npm run icons` | Regenera los PNG del icono desde `public/logo.svg` |
| `npm run release` | Compila y firma la APK de release en `release/` |
| `npm run preview` | Sirve el build de producción |

Para probar en el móvil dentro de la misma red, `npm run dev -- --host` y abre
la IP que imprime Vite. Es la forma más rápida de ver la app a tamaño real sin
generar todavía el APK.

---

## Los tres módulos

### Módulo 1 — Metas de sueño y avisos

Pantalla **Metas**. Tres formas de personalizar la meta:

- **Toda la semana**: un único objetivo para los siete días.
- **Semana + finde**: un horario de lunes a viernes y otro para sábado y domingo.
- **Día a día**: cada día por separado.

El estado guarda siempre los siete días; el modo sólo decide cuáles se editan a
la vez, así que cambiar de modo nunca pierde los valores anteriores
([`src/lib/schedule.ts`](src/lib/schedule.ts)).

De cada día se define la **hora de despertar** y las **horas objetivo**. A
partir de ahí se derivan tres avisos, con un margen de tolerancia deliberadamente
estrecho (±15 min por defecto), porque la regularidad pesa más que la duración
puntual:

1. **Aviso previo** (30 min antes) para ir bajando el ritmo.
2. **Aviso a la hora exacta** de acostarse.
3. **Aviso de retraso** al agotarse el margen, si está activado.

En el APK se programan como notificaciones locales con repetición semanal, de
modo que siguen disparándose con la app cerrada. En el navegador se usa la
Notification API mientras la pestaña está abierta
([`src/lib/notifications.ts`](src/lib/notifications.ts)).

### Módulo 2 — Hora de acostarse según los ciclos

Pantalla **Ciclos**. El sueño avanza en ciclos de unos 90 minutos; despertar al
final de uno, en fase ligera, evita la inercia de sueño de interrumpir una fase
profunda. El cálculo encaja un número entero de ciclos entre el momento de
dormirse y el de despertar, sumando la latencia (lo que se tarda en caer
dormido) ([`src/lib/cycles.ts`](src/lib/cycles.ts)).

Funciona en los dos sentidos:

- **Quiero despertar a las…** → a qué horas conviene acostarse (3 a 7 ciclos).
- **Me acuesto ahora** → a qué horas conviene poner la alarma.

La opción recomendada es la que menos se desvía de la meta del día. El anillo
muestra la noche completa con la composición estimada de cada ciclo: el sueño
profundo domina los primeros y el REM se alarga hacia el final.

Ambos parámetros son ajustables, porque la duración del ciclo varía entre 70 y
120 minutos según la persona.

### Módulo 3 — Monitorización por inactividad y estadísticas

Pantalla **Datos**. La duración del sueño se deduce del **tiempo que el
dispositivo pasa sin usarse**, nunca del tiempo que pasa sin abrirse la app.
Esa señal puede venir de varios sitios, y cada uno es un **disparador** que se
activa por separado desde Ajustes ([`src/lib/triggers.ts`](src/lib/triggers.ts)):

| Disparador | Abre el hueco | Lo cierra | Dónde | De fábrica |
| --- | --- | --- | --- | --- |
| **Bloqueo del móvil** | pantalla apagada | desbloqueo real | APK | activo |
| **Cargador** | lo enchufas | lo desenchufas | APK | apagado |
| **Reposo profundo** | Android entra en Doze | sale de Doze | APK | activo |
| **No molestar** | activas el filtro | lo quitas | APK | apagado |
| **Apertura de la app** | última marca de actividad | vuelves a abrirla | siempre | activo |
| **Horario objetivo** | — | — | siempre | apagado |

Son independientes porque **cada uno se rompe por su lado**: la pantalla no
dice nada de quien duerme sin bloqueo seguro, el cargador no sirve a quien no
carga de noche, Doze no llega si el móvil recibe notificaciones toda la
madrugada y «No molestar» sólo existe si el usuario lo usa. Lo que uno pierde,
otro lo cubre.

Los cuatro primeros los mide un servicio en primer plano
([`SleepMonitorService.java`](android/app/src/main/java/com/perfectrest/app/SleepMonitorService.java)).
Android sólo entrega `ACTION_SCREEN_OFF`, `ACTION_USER_PRESENT` y los eventos de
carga a receptores registrados en código y mientras un componente siga vivo, por
eso hace falta el servicio —y por eso Android obliga a mostrar una notificación
permanente mientras está activo. Se declara como
`foregroundServiceType="specialUse"`, se reanuda tras reiniciar el móvil y se
rearma con una **alarma exacta cada 15 minutos**: sin eso, deslizar la app fuera
de recientes o una limpieza de memoria de madrugada lo mataban en silencio y la
detección se quedaba reducida a las aperturas de la app. Por la misma razón
Ajustes ofrece **desactivar la optimización de batería**, que es la causa más
común de que el servicio no llegue vivo a la mañana.

El quinto es el respaldo: la app deja una marca temporal mientras está en
primer plano y mide el hueco desde la última
([`src/lib/activityMonitor.ts`](src/lib/activityMonitor.ts)). Es lo único que
funciona en el navegador, y depende de que mires el móvil poco antes de dormir y
poco después de despertar.

El sexto no mide nada: cuando una noche no ha dejado **ninguna** otra señal,
propone la sesión que marca tu meta para que la corrijas a mano. Va siempre con
confianza baja y viene desactivado de fábrica.

**Sensores opcionales** ([`src/lib/sensors.ts`](src/lib/sensors.ts),
[`SensorWatcher.java`](android/app/src/main/java/com/perfectrest/app/SensorWatcher.java)).
Los disparadores miden cuándo se usa el móvil; los sensores miden qué pasa a su
alrededor mientras no se usa. Se activan por separado en Ajustes, vienen
apagados, no usan el micrófono y se degradan si falta el sensor o el permiso:

| Sensor | Qué registra | Para qué se usa |
| --- | --- | --- |
| **Pasos y movimiento** | contador de pasos con entrega diferida (permiso «Actividad física»; sin él, movimiento significativo) | inicio = fin de la última actividad; despertar = primeros pasos sostenidos |
| **Luz ambiente** | cambios de nivel: oscuro / tenue / claro | la luz que se apaga marca el inicio; la oscuridad puntúa la confianza |
| **Proximidad** | móvil tapado / libre (sólo la variante que no despierta el procesador) | actividad al cogerlo de nuevo; quietud |
| **Próxima alarma** | `getNextAlarmClock`, sin permiso | si suena cerca del final, sube la confianza; con la pantalla encendida a esa hora, marca el despertar |
| **Audio sonando** | `isMusicActive`, muestreado con el vigilante de 15 min | mientras suene aún no se ha dormido |
| **Postura del móvil** | lecturas puntuales del acelerómetro: plano y quieto (boca arriba o abajo), inclinado y quieto, o en bolsillo/mano | plano y quieto es evidencia de quietud y sube la confianza; en bolsillo/mano aún no se duerme y el inicio se fija en el último momento así |

Sin wakelocks permanentes: los sensores entregan en lotes de 10 minutos y la
alarma y el audio sólo se consultan cuando el servicio ya está despierto. Todo
va al **registro bruto** (un evento por línea), que se cruza con cada hueco y se
exporta en CSV o JSON desde Ajustes, junto al historial.

**Postura del móvil** ([`SensorWatcher.java`](android/app/src/main/java/com/perfectrest/app/SensorWatcher.java)).
No deja ningún sensor escuchando: con la pantalla apagada y dentro de la ventana
nocturna, cada rearme del vigilante (**cada 10 minutos** de noche con este
sensor activo en vez de 15, por encima de los 9 que Android deja entre dos
alarmas en reposo; de día sigue a 15) y unos 45 s después de apagarse la
pantalla —para no leer el móvil aún en la mano— abre el acelerómetro unos
2,5 s, clasifica y lo cierra, con un wakelock de 6 s que se suelta solo. El
wakelock (`WAKE_LOCK`, permiso normal que no pregunta nada) sí hace falta: el
acelerómetro que no despierta el procesador deja de entregar en cuanto éste se
duerme, y la variante que sí lo despierta casi ningún móvil la trae. La clasificación mira la gravedad media (inclinación sobre
la horizontal y qué cara mira arriba) y el vaivén (desviación típica de la
aceleración): `0` plano boca arriba, `1` plano boca abajo, `2` en bolsillo o mano
(con vaivén), `3` inclinado y quieto (un soporte; no cuenta ni a favor ni en
contra). Una lectura suelta en el bolsillo no rompe la noche —puede ser una ida
al baño o un golpe en la mesa—; dos seguidas son un rato despierto: mueven el
inicio hasta el último momento con el móvil encima y, si ocurren tras cuatro
horas de sueño, marcan el despertar. Si el móvil no tiene acelerómetro, Ajustes
lo dice y el sensor no registra nada.

*Sin calibrar.* Los umbrales (15° de inclinación, 0,35 m/s² de vaivén en plano,
0,12 en inclinado, 70 % de lecturas planas para la quietud) son estimaciones
razonables, no medidas: hay que comprobarlos con noches reales. Un colchón muy
blando, un móvil apoyado en un soporte inclinado o un teléfono que vibra con
cada notificación pueden dar lecturas que no son lo que parecen, y por eso una
lectura aislada nunca mueve nada. Boca abajo la luz marca «oscuro» siempre, así
que la oscuridad de ese sensor no se corrige por la postura.

**Una noche no llega entera.** Ni el servicio ni la capa web pueden dar por
buena la primera señal de vuelta que reciben, porque durante la noche llegan
muchas que no lo son: Android sale de Doze cada pocas horas a su ventana de
mantenimiento y vuelve a entrar, y con un bloqueo por deslizamiento la pantalla
se enciende sola con cada notificación. Cada una de esas interrupciones cerraba
el hueco de la noche y abría otro, así que una noche de siete horas y media
quedaba troceada en descartes de hora y media y no se proponía nada. Dos
defensas lo evitan:

- El servicio **no cierra el hueco de Doze con la pantalla apagada** (salir de
  reposo sin encender la pantalla es el sistema, no el usuario) y **reanuda**
  cualquier hueco que se cerrara por debajo del mínimo si vuelve a abrirse en
  los 15 minutos siguientes. Una ida al baño no parte la noche en dos.
- La capa web **agrupa** los huecos que describen una misma noche —solapados o
  separados por menos de 15 minutos, lo mismo que aguanta el servicio— en vez de
  exigir solape estricto.
- Un **desvelo de madrugada** con el móvil en la mano (hasta hora y media) no
  parte la noche: si el primer trozo no es una noche entera por sí solo (menos de
  4 h 30 min) y empieza a tu hora, se une con el siguiente. La mañana quieta de
  después de una noche completa, o la tarde de antes, siguen sin pegarse.

De cada grupo se toma el borde de la **señal más directa** que contenga: la
pantalla, que mide el bloqueo real, manda sobre el cargador (que se enchufa
antes y se desenchufa después) y sobre Doze (que llega tarde y a trozos). La
coincidencia de varias señales sube el nivel de confianza. Toda sesión se puede
confirmar, ajustar o descartar:

- **fiable** — la puntuación combinada supera 0,7.
- **estimada** — entre 0,45 y 0,7.
- **dudosa** — por debajo de 0,45, demasiado corto, más largo que el máximo que fijes, o con el inicio **inferido** (ver «El reloj no inventa sueño»).

La puntuación ya no mira sólo la duración y la hora: combina **duración**
(6-10 h es lo más creíble), **cercanía a tu hora habitual** de acostarte y
levantarte, **acuerdo entre disparadores independientes** y, si activas los
sensores, **quietud** (pasos, movimiento y postura: móvil plano y quieto), **oscuridad** y **coincidencia con la alarma**. Las
evidencias que faltan no puntúan ni a favor ni en contra.

**Afinar el inicio y el final** ([`src/lib/activityMonitor.ts`](src/lib/activityMonitor.ts)).
Con datos reales el inicio salía de una a dos horas antes de lo cierto (se
suelta el móvil y se sigue despierto) y a veces el final se inflaba. Lo que se
hace ahora:

- **El final es el primer uso sostenido**, no el primer desbloqueo. El servicio
  sólo cierra la noche cuando el móvil se usa 5 minutos o se desbloquea 3 veces
  en un rato; un desbloqueo de segundos a las seis de la mañana es un
  *micro-despertar* y queda anotado en el hueco (`wakes`). Si un micro-despertar
  cae justo antes del uso sostenido (menos de 75 min), el despertar fue ése.
- **Una noche principal por día.** La tarde quieta y la mañana de después de
  despertar no se proponen como sueño; un hueco corto (menos de 4,5 h) que no
  empieza cerca de tu hora de acostarte se descarta, y los demás huecos del
  día sólo sobreviven como siesta con indicios propios (dos señales
  independientes, o sensores con oscuridad y quietud).
- **Techo de 13 h.** Un hueco mayor suele ser una tarde despierto más la noche:
  se parte por el micro-despertar que deja una noche creíble junto a tu hora de
  acostarte, o por la última actividad que vieron los sensores. Si no hay nada de
  eso, la noche se coloca a tu hora habitual como un **marcador inferido**
  (confianza baja, ver más abajo). Si esa hora no cae dentro del hueco no hay
  noche que proponer.
- **Aprendizaje ligero** ([`src/lib/habit.ts`](src/lib/habit.ts)). De las noches
  que corriges —editando la hora, escribiendo «me acosté a las 00:30» en el
  comentario o diciendo «correcto» o «es un margen aceptable»— se aprende tu
  hora de acostarte y levantarte, cuánto varía de una noche a otra y tu latencia
  de sueño (también de las noches que das por buenas, no sólo de las que
  corriges). Un inicio muy anterior a tu hora habitual **sólo** se adelanta
  hasta ella, menos lo que sueles variar (entre 20 min y 1 h), cuando hay
  evidencia de quietud (ver abajo); sin ella el hábito no toca el inicio.

**El reloj no inventa sueño.** «Nadie ha tocado el móvil» puede ser dormir o
estar despierto sin mirarlo, y la hora no distingue una cosa de otra. Antes, un
hueco largo sin micro-despertares empezaba la noche a tu hora habitual y un
inicio medido muy anterior a ella se adelantaba hasta el hábito: sueño deducido
por el reloj. Ahora:

- **El inicio nunca va antes del último uso real del móvil.** Ningún ajuste lo
  adelanta: sólo lo retrasan la latencia, la última actividad de un sensor, un
  micro-despertar real o el fin de un uso sostenido.
- **La hora habitual sólo mueve el inicio con evidencia de quietud**
  ([`quietEvidence`](src/lib/rawEvents.ts)): el móvil plano y quieto durante al
  menos el 70 % de las lecturas, o la noche a oscuras (80 %) sin pasos ni
  movimiento, y nada en contra (pasos, móvil en el bolsillo o la mano).
- **Sin evidencia la propuesta queda como dudosa**: confianza baja y marcada
  `inferred`, y la propuesta lo dice («la hora de dormirte no está medida»).
  La única excepción a la confianza baja es la noche colocada a tu hora
  habitual cuando el hábito es firme (7 noches o más con hora real y 1 h de
  variación como mucho) y la duración y el despertar medido encajan con él:
  sube a media, nunca a alta, y sigue siendo inferida. Una sesión inferida no se guarda sola con «guardar sin preguntar»
  —se queda en la cola para que la corrijas—, puntúa siempre por debajo de
  cualquier propuesta medida de su misma noche (no es noche principal por
  defecto ni bloquea a las demás) y la sustituye cualquier propuesta medida que
  llegue después. Son inferidas: la noche colocada a la hora habitual en un hueco
  de más de 13 h sin datos, el último uso del móvil más de 90 min anterior a tu
  hora de acostarte sin evidencia de quietud (con hábito aprendido) y la propuesta
  del disparador de horario, que sigue siendo el último recurso.
- **Un uso sostenido corta lo anterior.** El servicio sólo cierra el hueco de
  pantalla cuando el uso se sostiene (5 min de pantalla o 3 desbloqueos), y ya no
  lo *reanuda* si el móvil estuvo encendido ese rato: antes, doce minutos de móvil
  a las 22:30 tras soltarlo a las 22:00 devolvían el inicio a las 22:00. En la
  capa web, los huecos del cargador, de Doze o de «no molestar» que abarquen un
  uso sostenido (según el registro de pantalla, y sólo con desbloqueo: las
  pantallas que enciende una notificación no son uso) empiezan donde termina; y dos
  huecos de pantalla separados por uno ya no se funden salvo que el primero sea
  un desvelo en mitad de la noche. Lo posterior abre un ciclo nuevo con su
  propio inicio.

Las propuestas se guardan en **cola**, no de una en una: quien pasa un fin de
semana sin abrir la app vuelve con tres noches que confirmar, y antes la última
sobrescribía a las anteriores antes de que nadie las viera. Se enseña la
primera; al resolverla aparece la siguiente.

**El registro de detección.** Los disparadores no fallan con un error: si el
servicio no arrancó, si Android lo mató de madrugada, si el permiso de alarmas
exactas se retiró o si esa noche simplemente no llegó ninguna señal, el
resultado visible es siempre el mismo —ninguna sesión propuesta— y no había
dónde mirar. Por eso todo lo que ocurre queda anotado
([`src/lib/triggerLog.ts`](src/lib/triggerLog.ts)): cada señal recibida, cada
hueco encolado, cada descarte **con su motivo** y cada arranque o muerte del
servicio. Escriben en él las dos capas —el servicio nativo en un anillo de 200
eventos en `SharedPreferences`, la app al evaluar los huecos— y Ajustes los
funde en una sola lista ordenada, deduplicada (el registro nativo no se vacía
al leerse, así que los mismos eventos vuelven en cada apertura).

Lo que se lee de un vistazo es *«última señal del dispositivo: hace 6 h»*. Si
en cambio pone *«ninguna»* con el servicio en marcha y todos los permisos en
verde, el problema no es el sueño: es que nadie está escuchando.

Junto al registro hay un **probador**: inyecta un hueco de 8 h por el
disparador que elijas y lo hace recorrer la tubería real —cola nativa,
evaluación, fusión, propuesta—. No simula el evento de Android, que no se puede
falsificar desde la app y además escondería justo el fallo que importa; lo que
comprueba es todo lo que viene después. Si la prueba termina en «sesión
propuesta», lo que falla es la señal del sistema, no PerfectRest. La
alternativa era esperar una noche entera por intento, y con cuatro
disparadores eso no es probar nada.

**El aviso al despertar.** Una propuesta que espera a que abras la app es una
propuesta que no ves: al despertarse nadie abre PerfectRest, y la noche se
quedaba sin validar durante días, cuando ya no se recuerda si fue a las 23:40 o
a la una. Por eso, en cuanto se cierra el hueco, el servicio lanza una
notificación con la estimación —«Has dormido 7h 20m · De 23:40 a 07:00»— que
abre la app en la ficha de confirmación. Se activa y desactiva desde Ajustes
(«avisarme con la estimación al despertar») y viaja por un canal propio,
`perfectrest-summary`, separado del canal mudo del servicio para que se pueda
silenciar uno sin perder el otro.

Lo emite el servicio nativo y no la capa web a propósito: a las siete de la
mañana la app lleva horas cerrada y no hay ningún JavaScript vivo que pueda
avisar. El servicio avisa **una vez por noche**: una misma
mañana cierra tantos huecos como disparadores activos haya —la pantalla al
desbloquear, el cargador al desenchufar, «no molestar» al apagarse— y antes
llegaban dos o tres avisos seguidos diciendo duraciones distintas de la misma
noche. El filtro del servicio es laxo —el umbral mínimo y un extremo dentro de
la ventana nocturna—; la evaluación fina (confianza, fusión de disparadores,
corrección de bordes) sigue estando sólo en la capa web, porque duplicarla en
Java sólo garantizaría que las dos acaben desincronizadas. La cifra del aviso
es el hueco bruto; la que se guarda, la refinada.

Los bordes se corrigen antes de proponerla: al inicio se suma la latencia (uno
suelta el móvil antes de dormirse) y al final se restan 5 minutos (nadie coge el
móvil al instante de despertar). La propuesta del horario se libra, porque ya
está expresada en tiempo de sueño.

Las estadísticas ([`src/lib/stats.ts`](src/lib/stats.ts)) cubren duración media,
metas cumplidas, hora media de acostarse y despertar (con media circular, para
que 23:50 y 00:10 no promedien a mediodía), **consistencia** de horarios, deuda
de sueño acumulada y racha de noches cumplidas.

Una sesión pertenece al día en que uno **se despierta**: dormir de lunes 23:40 a
martes 07:10 es «la noche del martes».

### Contexto del dispositivo de cada noche

Para perfeccionar la detección hace falta saber qué hacía el móvil cuando se
acertó o se falló una noche. Cada sesión (detectada o manual) puede llevar un
campo opcional `context` ([`SessionContext`](src/lib/types.ts)): un resumen
**agregado** del tramo de media hora antes de dormirte a media hora después de
despertar, más el estado al inicio y al final. Lo calcula
[`src/lib/sessionContext.ts`](src/lib/sessionContext.ts), que es código puro
sobre el registro bruto del servicio; la parte asíncrona (leer el plugin) está
en [`contextCollector.ts`](src/lib/contextCollector.ts).

**Qué se guarda** (todo son recuentos, mínimos, máximos, porcentajes del tramo o
valores al inicio y al final):

| Sección | Contenido |
| --- | --- |
| Aparato | Modelo y fabricante, `SDK_INT` y versión de Android, versión de la app, idioma, zona horaria y desfase UTC al dormirte, qué sensores trae el móvil, exención de batería / alarmas exactas / notificaciones |
| Pantalla | Encendidos, desbloqueos, encendidos sin desbloquear (notificaciones), micro-despertares de la noche, duración de cada uso (hasta 20), uso total y máximo, si estaba encendida al dormirte y al despertar |
| Batería y carga | Enchufes y desenchufes, % del tramo enchufado, tipo de carga (pared, USB, inalámbrica, base), nivel de batería (inicio, fin, mín., máx.), temperatura mín. y máx. |
| Sistema | % del tramo en Doze, en ahorro de energía y en modo avión; filtro de «no molestar» (inicio y fin); modo del timbre (silencio, vibrar, normal); tipo de red y % sin conexión; nº de dispositivos Bluetooth **de audio** conectados; brillo; orientación |
| Sensores | Los que tengas activos para detectar: pasos y movimiento, luz (% oscuro/tenue/claro y lux mín./máx.), proximidad, postura. Siempre que haya datos: audio sonando y alarma (hora, si sonó, se canceló o no hubo actividad) |
| Cómo se detectó | Disparadores, confianza y puntuación, `inferred`, hueco medido, cuánto movió el refinado el inicio y el final, latencia usada y de dónde salió, hábito aprendido en ese momento, evidencia de los sensores y motivo de descarte de los otros huecos de la noche |
| Servicio | Reinicios por el sistema y errores durante el tramo |
| Línea de tiempo | Hasta 40 eventos destacados (desbloqueos, enchufes, modo avión, cambios de timbre…) con su minuto respecto al inicio |

**Qué no se guarda, nunca:** ubicación, nombre de la red Wi-Fi (SSID) ni de
ninguna red, nombres ni direcciones de dispositivos Bluetooth, contenido de
notificaciones, nombres de apps, contactos ni identificadores (IMEI, número de
serie, ID de Android, cuenta). De la red sólo se anota el *tipo* y si hay
conexión; de Bluetooth, *cuántos* dispositivos de audio hay conectados, contados
con el gestor de audio. Todo se calcula y se queda en el móvil; sólo sale si tú
lo exportas. No usa micrófono ni cámara.

**Cómo se recoge, sin gastar batería.** El servicio no añade temporizadores,
escuchas ni wakelocks. [`ContextSampler`](android/app/src/main/java/com/perfectrest/app/ContextSampler.java)
lee el estado del sistema sólo en momentos en que ya está despierto (cada rearme
del vigilante, al apagar o encender la pantalla, al enchufar o desenchufar) y
como mucho una vez cada 3 minutos; la batería sale de la difusión pegajosa, sin
registrar receptores. Anota en el registro bruto **sólo lo que cambia**, más una
lectura de refresco cada 6 horas para poder reconstruir el valor de una noche
aunque el registro haya rotado. Además escucha cuatro difusiones raras y
protegidas (modo avión, timbre, ahorro de energía y cargador) para anotarlas a
su hora. Cada lectura va en su propio `try/catch`: un parámetro que falta o un
permiso que no está sólo deja ese dato sin anotar, y el resumen lo omite. El
registro bruto sube de 2000 a 3000 eventos y ahora funde entradas del mismo
tipo aunque haya otras intercaladas.

**Permisos.** Sólo uno nuevo y *normal* (sin diálogo): `ACCESS_NETWORK_STATE`,
para saber si hay conexión y de qué tipo. No se pide ubicación, ni
`BLUETOOTH_CONNECT` (peligroso desde Android 12): los auriculares conectados se
cuentan con `AudioManager.getDevices`, que no lo necesita.

**Tamaño y limpieza.** Un contexto normal ocupa alrededor de 1,5 KB (120 noches,
unos 180 KB) y uno muy cargado —todos los sensores, 20 usos y la línea de tiempo
llena— unos 3 KB (unos 350 KB en el peor caso); se descarta al cargar cualquiera
de más de 8 KB o con otra forma. Se conservan los contextos de las
**120 noches más recientes** y de menos de un año
([`pruneContexts`](src/lib/sessionContext.ts)); las sesiones en sí no se tocan.
Las sesiones anteriores a la función siguen igual, sin `context`. El estado ya
no se reescribe en cada latido de la app, que cambiaba cada pocos segundos y
habría reescrito todo el historial.

**Cuándo.** La traza del algoritmo se guarda al proponer la noche. El resto se
recoge en un efecto del store con el registro bruto, también para las noches
manuales y las guardadas solas; se vuelve a calcular media hora después de
despertar (cuando el tramo ya está completo) y si corriges el inicio o el final,
mientras el registro bruto aún alcance (unos 3 días). Una noche cuyo registro ya
no cubre el tramo queda marcada como `partial`.

**Verlo, exportarlo y controlarlo.**

- En la hoja de sesión, la sección plegable **«Contexto del dispositivo»** lo
  cuenta en español.
- La exportación CSV añade `inferida`, `inicio_habitual` y ~60 columnas
  aplanadas (`pantalla_*`, `bateria_*`, `red_*`, `algo_*`…) al final, para no
  mover las de siempre; la cabecera es la misma aunque una noche no tenga
  contexto. El JSON lleva el contexto anidado tal como se guarda. La exportación
  del registro bruto sigue igual (con los eventos nuevos).
- En Ajustes, el interruptor **«Guardar contexto del dispositivo con cada
  noche»** (activado por defecto, con el texto de privacidad). Apagado, la app no
  guarda ningún contexto —tampoco el de una recogida que estuviera en curso— y el
  servicio deja de muestrear y de escuchar esas difusiones, y olvida las últimas
  lecturas para anotarlas todas de nuevo si se reactiva. **«Borrar contextos guardados»** los quita todos y no se vuelven a
  calcular; reactivar el ajuste sólo recoge las noches que acaben a partir de
  ese momento. **«Borrar registro bruto»** vacía además los eventos que el
  servicio guarda en el móvil.

### La hora habitual, a petición

Una propuesta con el inicio sin medir (`inferred`) y un hábito aprendido de tus
noches muestra el botón **«¿Desde las 23:40, como sueles?»**, en el aviso y en
la hoja de sesión. Sólo con tocarlo se pone esa hora como inicio —la ocurrencia
más cercana al inicio propuesto que deja entre 3 y 13 horas de sueño—; nunca se
aplica sola, y no aparece si el hábito sale del horario (`n = 0`) ni si no
cambia el inicio en más de 10 minutos. Tocarlo revisa la sesión: pasa a
*editada*, deja de ser inferida y sigue sin confirmar y editable (cambiar la
hora a mano deshace la marca `habitStart`). Esa hora **no enseña el hábito**:
aprender de una hora que salió del propio hábito lo reforzaría a sí mismo.

---

## Comprobaciones

`npm run check` ejecuta cinco suites, sin dependencias de testing:

- **Dominio** ([`scripts/selfcheck.ts`](scripts/selfcheck.ts)) — cálculo de ciclos
  en ambos sentidos, propagación de metas entre modos, ventanas que cruzan
  medianoche, medias circulares, estadísticas y detección de huecos de
  inactividad, y el formato de las etiquetas de release.
- **Noches simuladas** ([`scripts/nightsim.ts`](scripts/nightsim.ts)) — una noche
  entera, del evento de Android a la sesión propuesta; incluye la reanudación de
  huecos tras un uso sostenido y la noche que sigue a una tarde quieta.
- **Precisión** ([`scripts/precisioncheck.ts`](scripts/precisioncheck.ts)) — la
  lectura de los comentarios con la hora real, el hábito y la latencia
  aprendidos, la noche principal por día, los micro-despertares, la confianza
  combinada, los sensores —con la postura del móvil—, el inicio dudoso sin
  evidencia de quietud y el corte por uso sostenido. También el contexto del
  dispositivo: el resumen de una noche sintética (pantalla, carga, red, alarma,
  sensores), que 3000 eventos no pasen de 8 KB, que no haya campos de ubicación,
  SSID ni identificadores, la migración y la poda a 120 noches, el CSV y el JSON
  con contexto, la traza del algoritmo, que los eventos nuevos no muevan la
  evidencia de la detección y la hora habitual a petición.
- **Banco de pruebas** ([`scripts/backtest.ts`](scripts/backtest.ts)) — carga un
  historial real con comentarios («me acosté a las 00:30», «correcto», «no he
  dormido»), reconstruye el hueco bruto de cada sesión y lo hace pasar de nuevo
  por la tubería actual, midiendo error de inicio y final, falsos positivos y
  noches perdidas frente a lo que se guardó. Usa un fixture reducido
  (`scripts/fixtures/sueno-etiquetado.json`); con
  `PERFECTREST_LABELED=/ruta/historial.json npm run check` (y
  `PERFECTREST_VERBOSE=1` para el detalle noche a noche) se lanza con tus datos.
  Además del error medio, separa las propuestas **dudosas** (inicio inferido) de
  las firmes: lo que el reloj ya no deduce no desaparece, se marca. Con el
  historial real de referencia, el error medio de inicio en línea pasó de 23 a
  32 min (mediana 8 → 11 min) al dejar de adelantar el inicio al hábito sin
  evidencia: 6 de las 18 noches etiquetadas salen dudosas, y las 12 firmes
  quedan a 16 min de media (7 min con el hábito ya aprendido). Con sensores de
  quietud, el hábito vuelve a poder mover el inicio. También da el error del
  inicio por confianza (con el hábito aprendido: alta 0 min, media 45, baja 65),
  que es lo que dice si la etiqueta de la propuesta es honesta.
- **Render** ([`scripts/rendercheck.tsx`](scripts/rendercheck.tsx)) — cada
  pantalla se renderiza fuera del navegador para detectar errores de render,
  con la sección plegable del contexto, el botón de la hora habitual y el
  interruptor de privacidad de Ajustes; y el estado: un contexto que llega
  después de apagar el ajuste o de borrar los contextos no se guarda. La
  auditoría de maquetación (`npm run layout`) incluye una propuesta dudosa con
  el botón de la hora habitual y la sección del contexto desplegada.

El contexto del dispositivo no cambió las reglas de huecos del servicio (sólo
añadió muestreo), así que el modelo de `nightsim.ts` sigue siendo fiel, y el
banco de pruebas da las mismas cifras: error de inicio medio 32 min en línea, 0
falsos positivos, 0 noches perdidas.

La suite de noches existe porque las otras entraban por la mitad de la tubería:
le daban a `evaluateGap` un hueco limpio de 23:30 a 07:00 que se inventaba la
propia prueba. Una noche real no produce eso, produce media docena de trozos, y
ahí estaba el fallo. Cada escenario es una ristra de eventos del sistema
—apagados de pantalla, entradas y salidas de Doze, cargador, «no molestar»,
muertes del servicio— que recorre un modelo de `SleepMonitorService` y después
el código real de evaluación y fusión, y se compara el resultado con lo que el
usuario durmió de verdad. Cubre la noche con ventanas de mantenimiento de Doze,
la que se pasa sin bloqueo seguro con la pantalla encendiéndose sola, la del
cargador, la de sólo «no molestar», el servicio muerto y rearmado a mitad y el
despertar breve de madrugada.

El modelo del servicio es la parte frágil: está en Java y no se puede importar,
así que se ha reescrito en TypeScript dentro de la suite. Cada regla que debe
coincidir línea por línea con el Java lleva un comentario `SPEC:` con el nombre
del método original; si se toca `openGap` o `closeGap` en el servicio, hay que
tocarlos también aquí o la simulación deja de demostrar nada.

La lógica pura del servicio que tiene reglas propias en Java —la clasificación
de la postura a partir de una ráfaga del acelerómetro y cuándo se reanuda un
hueco— se prueba con JUnit
([`PostureTest.java`](android/app/src/test/java/com/perfectrest/app/PostureTest.java),
`gradlew testDebugUnitTest`) y el muestreo del contexto —cuándo se anota un valor,
códigos de carga y red, cuenta de auriculares Bluetooth y fusión de eventos del
registro bruto— en
[`ContextSamplerTest.java`](android/app/src/test/java/com/perfectrest/app/ContextSamplerTest.java);
sin Gradle se puede compilar con `javac` contra el
`android-all` de Robolectric (Maven Central, API 34) y stubs mínimos de
Capacitor y AndroidX, y ejecutar con `JUnitCore`.

Además, con el servidor de desarrollo en marcha:

```bash
npm run layout        # auditoría de maquetación en un navegador real
npm run shots         # capturas de cada pantalla en screenshots/
```

[`scripts/layoutcheck.mjs`](scripts/layoutcheck.mjs) abre la app a 320, 360,
390, 430 y 520 px, recorre las cinco pantallas (arriba y con la página al
final) en tema claro, oscuro, onboarding y con una sesión pendiente, y falla si
encuentra scroll horizontal, cajas fuera del viewport, texto desbordado,
solapamientos, contenido tapado por la barra fija, zonas táctiles menores de
32 px o cualquier margen que no salga de la escala de espaciado del tema.

---

## Identidad visual

La marca es una **luna creciente dentro de un arco abierto**: el arco es el
mismo ciclo que dibuja la pantalla de Ciclos, y su hueco, arriba a la derecha,
coincide con el lado por el que la luna se abre. El degradado va del violeta
`#8E7BFF` al menta `#4FE0BE`, los dos acentos del tema.

El original es [`public/logo.svg`](public/logo.svg), un lienzo de 100×100 con
sólo dos trazados. De ahí salen los tres usos:

| Uso | Fichero | Notas |
| --- | --- | --- |
| Icono del lanzador | [`drawable/ic_launcher_foreground.xml`](android/app/src/main/res/drawable/ic_launcher_foreground.xml) | Adaptativo sobre fondo `#090D1A`, con capa `monochrome` para los iconos temáticos de Android 13+ |
| Icono heredado | `mipmap-*/ic_launcher*.png` | Sólo lo usan API 24 y 25; se generan con `npm run icons` |
| Pantalla de arranque nativa | [`drawable/splash.xml`](android/app/src/main/res/drawable/splash.xml) | Vectorial; en Android 12+ manda [`values-v31/styles.xml`](android/app/src/main/res/values-v31/styles.xml) |
| Pantalla de carga animada | [`index.html`](index.html) | 1,5 s: el arco se dibuja, la luna entra, aparece el nombre y todo se funde |
| Icono de notificación | [`drawable/ic_stat_icon.xml`](android/app/src/main/res/drawable/ic_stat_icon.xml) | Silueta blanca sobre transparente, como exige Android |
| Favicon | [`public/moon.svg`](public/moon.svg) | La marca sobre la baldosa oscura |

**Cuánto ocupa la marca.** Android recorta los iconos y cada sitio lo hace con
una máscara distinta, así que el tamaño no es una cuestión estética sino de no
perder el arco por los lados:

- **Lanzador (108dp):** la marca ocupa **60dp**, la línea guía de Material para
  una silueta circular. La zona segura son 72dp, pero llenarla entera no deja
  margen para el paralaje del lanzador, para el reencuadre de los iconos
  temáticos ni para las máscaras de fabricante, que recortan por debajo.
- **Arranque de Android 12+:** el sistema **recorta el icono a un círculo de
  dos tercios del drawable**. Por eso `ic_splash_logo` lleva el margen dentro
  (lienzo 150 para un dibujo de 100) y `splash.xml`, que no recorta, lo pide
  1,5 veces más grande para compensar.
- **Heredado y favicon:** 60% de una baldosa que ya trae su propio fondo.

`npm run icons --preview` deja en `screenshots/icon-preview.png` una hoja de
contacto con el adaptativo **ya enmascarado**, que es la única forma de ver por
dónde lo van a cortar.

Casi todo es vectorial: un cambio en el dibujo se propaga editando los trazados.
Los únicos mapas de bits son los `mipmap-*` de respaldo, y se rasterizan con el
Chrome del sistema:

```bash
npm run icons                    # regenera los PNG
node scripts/icons.mjs --preview # además, una hoja de contacto en screenshots/
```

La animación de carga vive en el HTML y no en React a propósito: se pinta en el
primer fotograma, antes de que el bundle se descargue, así que releva a la
ventana de arranque nativa sin ningún parpadeo. Se quita del DOM a los 1500 ms
para no dejar una capa invisible interceptando toques, y con
`prefers-reduced-motion` la marca aparece ya montada y sólo se funde.

---

## El APK

El proyecto Android ya está generado en [`android/`](android/) y el APK
compilado está en la raíz como **`PerfectRest.apk`** (4,2 MB, depuración).

Para instalarlo en un móvil conectado por USB con depuración activada:

```bash
adb install -r PerfectRest.apk
```

O copia el archivo al teléfono y ábrelo, permitiendo la instalación de orígenes
desconocidos.

Para regenerarlo tras cambiar el código:

```bash
npm run android:apk     # build web + sync + gradle assembleDebug
```

Queda en `android/app/build/outputs/apk/debug/app-debug.apk`. Para abrir el
proyecto en Android Studio, `npm run android:open`.

`android/local.properties` apunta al SDK de esta máquina y no debe compartirse.

### Los permisos son el punto débil de todo esto

Ninguno de los permisos que necesita la detección falla con un error. Si falta
alguno, la app no se rompe: **simplemente deja de registrar noches**, que desde
fuera es indistinguible de una noche en la que no dejaste ninguna señal. Ése era
el fallo real —la detección parecía no funcionar sin que nada dijera por qué—, y
por eso Ajustes abre con una tarjeta de diagnóstico que los recorre uno a uno,
cada uno con su atajo directo a la pantalla del sistema que lo concede:

| Requisito | Qué pasa sin él | Cómo se concede |
| --- | --- | --- |
| **Notificaciones** | No hay recordatorios, ni aviso al despertar, ni notificación del servicio | Diálogo en el onboarding; después, ajustes del sistema |
| **Sin optimización de batería** | Android para el servicio de madrugada y se pierde la noche entera | Se pide en el onboarding y desde el diagnóstico |
| **Alarmas exactas** | El vigilante se degrada a alarma inexacta, Doze la agrupa y el servicio puede no rearmarse en toda la noche | Pantalla «alarmas y recordatorios» |
| **Servicio vivo** | No es un permiso: es el resultado de los tres anteriores | — |

Tres detalles que hacían que esto fallara en silencio y ya no:

- **Un permiso denegado dos veces no vuelve a preguntarse.** Android deja de
  mostrar el diálogo a la segunda negativa, así que el botón «conceder permiso»
  dejaba de hacer nada sin decirlo. Ahora, cuando ya no hay diálogo posible, el
  botón lleva a la ficha de la app en los ajustes del sistema.
- **Cada actualización apagaba la detección.** Instalar una versión nueva
  detiene la app por completo y cancela sus alarmas, la del vigilante incluida.
  Como PerfectRest se actualiza sola con cada push a `main`, el servicio se
  quedaba muerto hasta que alguien volviera a abrir la app —y como no hay nada
  visible que falle, podían pasar semanas. `BootReceiver` atiende ahora
  `MY_PACKAGE_REPLACED` además del arranque del dispositivo.
- **El estado del servicio mentía.** `start()` respondía «en marcha» sin
  comprobar nada, y `getRunningServices` informa del proceso, no de que el
  servicio siga escuchando. Ahora el servicio deja un latido en cada arranque y
  en cada evento recibido, y se le da por muerto si lleva más de 45 minutos sin
  tocarlo (el vigilante pasa cada 15). Todo lo que puede fallar por un permiso
  —entrar en primer plano, programar la alarma exacta, publicar el aviso— queda
  anotado y Ajustes lo muestra en vez de dejarlo morir en el log.

### Qué se ha comprobado en un dispositivo

Sobre un emulador Android 16 (API 36), con el APK instalado:

- La app arranca, carga y navega correctamente.
- El servicio de segundo plano arranca en primer plano
  (`isForeground=true`, tipo `specialUse`).
- Con la app **cerrada**, bloquear la pantalla y desbloquearla después registra
  el hueco de inactividad con su marca de inicio y fin.
- Al abrir la app, el hueco se lee, se evalúa, se vacía la cola nativa y
  aparece el aviso de sesión detectada con su nivel de confianza.

La detección se probó con un umbral reducido a 1 minuto para no esperar horas;
el umbral real por defecto son 3 horas.

---

## Autoactualización

Un `git push` a `main` acaba convertido en una actualización instalada en el
móvil, sin descargar ningún APK a mano ni entrar en ninguna web.

```
git push a main
      │
      ▼
GitHub Actions            compila y FIRMA la APK
      ▼
GitHub Release            tag: v<versionName>-b<versionCode>, con la APK adjunta
      ▼
La app, al arrancar       1. consulta api.github.com  (JavaScript, pasa por CORS)
                          2. compara versionCode
                          3. descarga la APK           (Java, sin CORS)
                          4. abre el instalador
      ▼
1 toque del usuario → instalada, datos intactos
```

**Lo que no puede hacer:** instalar en silencio. Eso exige ser *device owner* o
app de sistema. Todo lo demás —comprobar, descargar, preparar— es automático,
pero el último paso es siempre un diálogo del sistema.

### El reparto entre JavaScript y Java no es casual

La WebView corre en un origen `localhost`, así que sus peticiones pasan por
CORS:

| Petición | ¿Manda `Access-Control-Allow-Origin`? |
| --- | --- |
| `api.github.com/repos/.../releases/latest` | **sí**, `*` |
| La URL de descarga de un asset de release | **no** (redirige a otro host) |

Por eso el `versionCode` sale de la **etiqueta** de la release (`v0.1.0-b23` →
23), que ya viene en la respuesta de la API: publicar un `latest.json` como
asset y leerlo con `fetch` sería lo natural y no funcionaría nunca. La APK sí se
descarga del asset, pero eso lo hace
[`UpdaterPlugin.java`](android/app/src/main/java/com/perfectrest/app/UpdaterPlugin.java),
que además evita pasar varios megas en base64 por el puente de Capacitor.

### El versionado

`versionCode` = **número de commits** (`git rev-list --count HEAD`), calculado
en [`android/app/build.gradle`](android/app/build.gradle). Crece solo con cada
push y nadie tiene que acordarse de subirlo; Android sólo acepta actualizar a un
`versionCode` estrictamente mayor. `versionName` sale de `package.json`, que es
lo que ve el usuario.

**Contrapartida:** no se puede reescribir la historia de `main`. Un rebase o un
`push --force` que reduzca el número de commits dejaría las releases nuevas por
debajo de lo ya instalado y el canal se rompería en silencio. Por eso
`scripts/release-apk.mjs` aborta si el `versionCode` calculado no supera al de
la última APK publicada.

### Puesta en marcha (una sola vez)

1. **Repositorio público en GitHub.** La app consulta la API sin credenciales;
   en uno privado recibiría un 404 y no ofrecería nada nunca. Meter un token en
   el APK no es una opción. El slug `owner/repo` no se escribe a mano: sale del
   remoto de git en tiempo de compilación
   ([`vite.config.ts`](vite.config.ts)).

2. **Generar la clave de firma:**

   ```bash
   npm run keystore
   ```

   Crea `android/perfectrest-release.jks` y `android/keystore.properties` (los
   dos en `.gitignore`) e imprime lo que hay que pegar en los secrets. **Guarda
   una copia del `.jks` fuera del proyecto:** Android identifica una app por
   applicationId + firma, así que si se pierde la clave ningún dispositivo con
   PerfectRest instalada podrá volver a actualizarse —habría que desinstalar y
   reinstalar, perdiendo las noches registradas.

3. **Crear cuatro secrets** en *Settings → Secrets and variables → Actions*,
   pestaña **Secrets** (no *Variables*: ese error da un fallo mudo):
   `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

4. **Instalar a mano la primera APK firmada** con la clave nueva. La instalación
   actual va firmada con la clave de debug, así que hay que desinstalarla antes;
   a partir de ahí el canal se sostiene solo.

Para compilar una release en local: `npm run release` (deja el APK en
`release/`). Sin `keystore.properties` avisa y firma con la clave de debug: sirve
para probar, no para publicar.

### La comprobación manual no es un adorno

La comprobación del arranque **calla sus errores** a propósito: sin cobertura, o
con GitHub devolviendo 403 por límite de peticiones, la app tiene que seguir
funcionando sin molestar. El precio de ese diseño es que un fallo real se ve
exactamente igual que «no hay novedades».

Por eso Ajustes incluye una comprobación manual que sí cuenta lo que ocurre:
versión encontrada, ya al día, o el error exacto. Es la única forma de
distinguir «no hay nada» de «está roto».

### El permiso se concede fuera de la app

En Android 8+, «instalar apps desconocidas» se da por aplicación en una pantalla
de ajustes del sistema, y nada dentro de la app avisa de que ha cambiado. El
estado se relee al volver al primer plano
([`src/state/update.tsx`](src/state/update.tsx)); si no, el aviso seguiría
pidiendo un permiso ya concedido para siempre. Como la APK ya está descargada,
al recuperar el permiso el botón vuelve directo a «Instalar».

---

## Estructura

```
src/
  lib/
    types.ts             modelo de dominio
    time.ts              formato de horas, ventanas nocturnas, medias circulares
    cycles.ts            Módulo 2: cálculo de ciclos
    schedule.ts          Módulo 1: metas y modos de personalización
    notifications.ts     Módulo 1: avisos (nativos y de navegador)
    activityMonitor.ts   Módulo 3: detección por inactividad
    habit.ts             Módulo 3: hábito de sueño y latencia aprendidos
    noteTimes.ts         Módulo 3: hora real que cuenta el comentario de una noche
    rawEvents.ts         Módulo 3: registro bruto y evidencias de los sensores
    sensors.ts           Módulo 3: catálogo de sensores opcionales
    sessionContext.ts    Módulo 3: contexto del dispositivo de cada noche (puro)
    contextCollector.ts  Módulo 3: recogida del contexto desde el plugin
    updater.ts           Autoactualización: API de GitHub y versiones
    triggers.ts          Módulo 3: catálogo de disparadores
    triggerLog.ts        Módulo 3: registro de señales, huecos y descartes
    stats.ts             Módulo 3: estadísticas e interpretación
    storage.ts           persistencia (Preferences en el APK, localStorage en web)
  state/
    store.tsx            estado global, hidratación y efectos
    update.tsx           estado del canal de autoactualización
  components/            sistema de diseño y visualizaciones SVG
  screens/               una pantalla por módulo, más Inicio y Ajustes
  styles/theme.css       paleta y tokens de diseño

public/
  logo.svg               la marca, origen de todo el juego de iconos
  moon.svg               favicon: la marca sobre la baldosa oscura

scripts/
  release-apk.mjs        compila y firma la APK de release (local y en CI)
  keystore.mjs           genera la clave de firma, una sola vez
  icons.mjs              rasteriza los mipmap heredados desde logo.svg
.github/workflows/
  release.yml            publica la release en cada push a main
```

Todos los datos se guardan **solo en el dispositivo**. No hay cuenta, servidor
ni telemetría.

---

Las estimaciones de ciclos son orientativas y no sustituyen el criterio médico.
