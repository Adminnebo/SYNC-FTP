# nebo-ftp-image-sync

Sincroniza a diario un **SFTP** (Azure Blob Storage, `jheacloudservice`) hacia
**Supabase Storage**:

| Carpeta del SFTP | Contenido | Bucket |
|---|---|---|
| `/imagenes` | imágenes de producto (`<codigo>.png`) | `Lucas_imagenes` |
| `/fichastecnicas` | fichas técnicas (`<codigo>.pdf`) | `Lucas_fichas_tecnicas` |

Es _stateless_ (no guarda estado entre ejecuciones): en cada corrida lista el
SFTP y el bucket, y sube un archivo si **no está** en el bucket o si su
**tamaño cambió** (se reemplazó en el SFTP con el mismo nombre). Así funciona en
la nube (GitHub Actions) y una corrida cortada se retoma sola en la siguiente.

Reemplaza a los syncs anteriores de FTP (`migrate.js`) y Google Drive
(`drive-sync.js`), que alimentaban esos mismos buckets.

## Comandos

```bash
npm install
node sftp-sync.js        # Sync: sube lo nuevo o reemplazado
node sftp-sync.js test   # Igual, pero sube como máximo 10 archivos por carpeta (prueba)
```

Para correr local: copiá `.env.migration.example` a `.env.migration` y completá los valores.

## Automatización (GitHub Actions)

[sync-sftp.yml](.github/workflows/sync-sftp.yml) corre a diario a las 07:00 UTC
(≈ 04:00 Argentina) y también se dispara a mano desde **Actions → Run workflow**.

### Secrets requeridos

En el repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Requerido | Notas |
|---|---|---|
| `SFTP_HOST` | ✅ | `jheacloudservice.blob.core.windows.net` |
| `SFTP_USER` | ✅ | Usuario SFTP |
| `SFTP_PASSWORD` | ✅ | Contraseña |
| `SFTP_SUPABASE_URL` | ✅ | `https://xxxx.supabase.co` del proyecto con los buckets |
| `SFTP_SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (no la anon) |
| `SFTP_PORT` | opcional | Default `22` |

## Notas

- Un reemplazo se detecta por **tamaño**: si un archivo cambia pero queda con
  exactamente el mismo tamaño en bytes, no se re-sube.
- Nunca borra del bucket lo que desaparece del SFTP.
- Los nombres con acentos o `ñ` se normalizan (`Núñez` → `Nunez`) porque
  Supabase Storage no acepta esos caracteres en la clave.
- Un fallo de subida pone el workflow en rojo (para enterarte); lo que no se
  subió se reintenta solo en la próxima corrida.
- Cambiá la hora editando el `cron` del workflow (está en UTC).
