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
node migrate.js sync       # Sync diario: sube solo lo que NO está ya en el bucket
```

Para correr local: copiá `.env.migration.example` a `.env.migration` y completá los valores.

## Automatización (GitHub Actions)

El workflow [.github/workflows/sync-ftp-images.yml](.github/workflows/sync-ftp-images.yml)
corre `node migrate.js sync` todos los días a las **07:00 UTC (≈04:00 Argentina)**.
También se puede disparar a mano desde la pestaña **Actions → Run workflow**.

### Secrets requeridos

En el repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Requerido | Notas |
|---|---|---|
| `FTP_HOST` | ✅ | Host del FTP |
| `FTP_USER` | ✅ | Usuario |
| `FTP_PASSWORD` | ✅ | Contraseña |
| `SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (no la anon) |
| `SUPABASE_BUCKET` | ✅ | Nombre del bucket |
| `FTP_PORT` | opcional | Default `21` |
| `FTP_BASE_PATH` | opcional | Default `/` |

> El FTP tiene que ser accesible desde internet (los runners de GitHub corren en la nube).

## Notas

- Detecta imágenes **nuevas** (rutas nuevas). Si se reemplaza una imagen manteniendo
  la misma ruta, no se re-sube.
- Cambiá la hora editando el `cron` del workflow (está en UTC).
