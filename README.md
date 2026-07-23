# nebo-ftp-image-sync

Sincroniza a diario las imágenes de un FTP hacia un bucket de **Supabase Storage**.
Sube **solo las imágenes nuevas**: en cada corrida lista lo que ya existe en el
bucket y solo transfiere lo que falta (es _stateless_, no guarda estado entre
ejecuciones), así que funciona perfecto en la nube (GitHub Actions).

## Comandos

```bash
npm install
node migrate.js discover   # Lista todas las imágenes del FTP -> discovery.json (no sube nada)
node migrate.js test       # Sube las primeras 10 imágenes (prueba)
node migrate.js run        # Migración completa con reintentos (usa migration.log.json local)
node migrate.js sync       # Sync diario FTP: sube solo lo que NO está ya en el bucket
node drive-sync.js         # Sync diario DRIVE: carpeta pública de Google Drive -> bucket
```

Para correr local: copiá `.env.migration.example` a `.env.migration` y completá los valores.

## Dos syncs independientes

Este repo tiene dos orígenes, cada uno con su comando, su workflow y su bucket:

| Origen | Qué sube | Comando | Workflow | Bucket (secret) |
|---|---|---|---|---|
| FTP | imágenes | `node migrate.js sync` | `sync-ftp-images.yml` (07:00 UTC) | `SUPABASE_BUCKET` |
| Google Drive (público) | cualquier archivo descargable (PDF, imágenes, …) | `node drive-sync.js` | `sync-drive-images.yml` (07:30 UTC) | `DRIVE_SUPABASE_BUCKET` |

Ambos son _stateless_: en cada corrida listan lo que ya existe en su bucket y suben solo lo nuevo. El de Drive omite los archivos nativos de Google (Docs/Sheets/Slides), que no se pueden descargar directo.

## Automatización (GitHub Actions)

Los workflows corren a diario (hora en UTC) y también se disparan a mano desde
**Actions → Run workflow**.

### Secrets requeridos

En el repo: **Settings → Secrets and variables → Actions → New repository secret**.

**FTP** ([sync-ftp-images.yml](.github/workflows/sync-ftp-images.yml)):

| Secret | Requerido | Notas |
|---|---|---|
| `FTP_HOST` | ✅ | Host del FTP |
| `FTP_USER` | ✅ | Usuario |
| `FTP_PASSWORD` | ✅ | Contraseña |
| `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (no la anon) |
| `SUPABASE_BUCKET` | ✅ | Bucket de las imágenes del FTP |
| `FTP_PORT` | opcional | Default `21` |
| `FTP_BASE_PATH` | opcional | Default `/` |

**Google Drive** ([sync-drive-images.yml](.github/workflows/sync-drive-images.yml)) — usa su **propio proyecto de Supabase** (distinto al del FTP):

| Secret | Requerido | Notas |
|---|---|---|
| `GOOGLE_API_KEY` | ✅ | API key de Google Cloud con la Drive API habilitada |
| `DRIVE_FOLDER_ID` | ✅ | Id de la carpeta (el tramo final de la URL `/folders/<ID>`) |
| `DRIVE_SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` del proyecto de Drive |
| `DRIVE_SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key de ese proyecto |
| `DRIVE_SUPABASE_BUCKET` | ✅ | Bucket destino (ej. `Lucas_fichas_tecnicas`) |

> - El FTP tiene que ser accesible desde internet (los runners de GitHub corren en la nube).
> - La carpeta de Drive tiene que ser **pública** ("cualquiera con el enlace"). Si se hace privada, hay que migrar a service account.

### Cómo obtener la `GOOGLE_API_KEY`

1. [Google Cloud Console](https://console.cloud.google.com/) → creá/elegí un proyecto.
2. **APIs & Services → Library** → buscá **Google Drive API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**. Copiá la key.
4. (Opcional pero recomendado) editá la key → **API restrictions** → restringila a **Google Drive API**.

## Notas

- Detecta imágenes **nuevas** (por ruta/nombre). Si se reemplaza una imagen
  manteniendo el mismo nombre, no se re-sube.
- En Drive, si hubiera **archivos con el mismo nombre** en la misma carpeta,
  solo uno queda en el bucket. Si eso pasa, se puede cambiar la clave del objeto
  al **id único de Drive** (ver `drive-sync.js`, función `walkDrive`).
- Cambiá la hora editando el `cron` de cada workflow (está en UTC).
