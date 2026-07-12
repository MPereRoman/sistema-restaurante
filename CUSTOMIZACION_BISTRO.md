# Personalización de Bistro Ciento44

## Identidad visual

- `views/partials/navbar.ejs`: nombre que aparece en el encabezado.
- `views/partials/footer.ejs`: contenido del pie de página.
- `views/index.ejs`: título de la pestaña principal.
- Los bloques `<style>` de cada archivo en `views/` controlan colores locales.
- `public/css/` contiene los estilos compartidos que pueden centralizarse más adelante.

## Productos y unidades

- `views/productos.ejs`: columnas y formulario de productos.
- `public/js/productos.js`: datos enviados al guardar un producto.
- `views/index.ejs`, `public/js/index.js` y `public/js/factura.js`: captura de venta directa.
- `public/js/mesas.js`: captura de productos en pedidos por mesa.
- `routes/productos.js`: plantilla e importación de Excel.

Kilogramos permanece en la base de datos, pero está oculto. Libras no se captura ni se muestra; sus columnas de base se conservan únicamente para compatibilidad con datos históricos.

## Formas de pago

- `views/index.ejs`: selector de pago de venta directa.
- `public/js/factura.js`: desglose de pago mixto en venta directa.
- `public/js/mesas.js`: desglose de pago mixto en pedidos por mesa.
- `routes/facturas.js` y `routes/mesas.js`: validación del servidor.
- `views/ventas.ejs` y `routes/ventas.js`: visualización y exportación de totales.

Para habilitar tarjeta en el futuro hay que agregar `tarjeta` tanto en los selectores del frontend como en las listas permitidas del backend. La base de datos conserva compatibilidad con ese método.

## Personas y consumo promedio

- `database.sql` y `db.js`: columna `pedidos.numero_personas` y migración automática.
- `routes/mesas.js`: solicita el dato solo al crear un pedido nuevo.
- `views/mesas.ejs` y `public/js/mesas.js`: captura y cálculo del promedio en vivo.

## Eliminación de mesas

- `routes/mesas.js`: baja lógica mediante `mesas.activa`.
- Una mesa con productos activos no puede eliminarse.
- Una mesa libre puede ocultarse conservando todos sus pedidos históricos.
- Si se crea nuevamente el mismo número de mesa, se reactiva la fila histórica.
