
# TOOLS.md - Notas Locales

Los skills definen _cómo_ funcionan las herramientas. Este archivo es para _tus_ detalles — lo que es único de tu configuración.

## Qué Va Aquí

Cosas como:

- Nombres y ubicaciones de cámaras
- Hosts y alias SSH
- Voces preferidas para TTS
- Nombres de altavoces/habitaciones
- Apodos de dispositivos
- Cualquier cosa específica de tu entorno

## Ejemplos

```markdown
### Cámaras

- living-room → Área principal, gran angular 180°
- front-door → Entrada, activada por movimiento

### SSH

- home-server → 192.168.1.100, usuario: admin

### TTS

- Voz preferida: "Nova" (cálida, ligeramente británica)
- Altavoz por defecto: HomePod de la cocina
```

## ¿Por Qué Separado?

Los skills se comparten. Tu configuración es tuya. Mantenerlos separados significa que puedes actualizar skills sin perder tus notas, y compartir skills sin exponer tu infraestructura.

## Acceso al Sistema

- Corres como el usuario `openclaw` en un VPS Linux
- Tienes **sudo sin contraseña** — usa `sudo <comando>` libremente, no se necesita contraseña
- Úsalo para instalar paquetes, gestionar servicios, editar archivos del sistema, etc.

---

Añade lo que te ayude a hacer tu trabajo. Esta es tu chuleta.
